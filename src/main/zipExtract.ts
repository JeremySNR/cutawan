import { createWriteStream } from 'node:fs'
import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw, crc32 } from 'node:zlib'
import { Transform, type TransformCallback } from 'node:stream'

/**
 * Minimal .zip extraction for handoff packages, so importing one does not
 * need a new dependency. It reads the central directory, supports the two
 * methods every zip writer uses (stored and deflate) and refuses anything it
 * cannot vouch for: entries that would land outside the target directory
 * ("zip slip"), absolute or drive-letter paths, encrypted entries, ZIP64
 * archives and CRC mismatches. Entries stream to disk, so a large stringout
 * never sits in memory.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** End-of-central-directory record plus the longest allowed comment. */
const EOCD_SEARCH_BYTES = 22 + 0xffff

export class ZipError extends Error {}

interface Entry {
  name: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await file.read(buffer, 0, length, position)
  return buffer.subarray(0, bytesRead)
}

async function centralDirectory(file: FileHandle, fileSize: number): Promise<Entry[]> {
  const tailStart = Math.max(0, fileSize - EOCD_SEARCH_BYTES)
  const tail = await readAt(file, tailStart, fileSize - tailStart)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) { eocd = i; break }
  }
  if (eocd < 0) throw new ZipError('This is not a zip file, or it is damaged.')
  const count = tail.readUInt16LE(eocd + 10)
  const size = tail.readUInt32LE(eocd + 12)
  const offset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported. Import the unzipped package folder instead.')
  }
  const directory = await readAt(file, offset, size)
  const entries: Entry[] = []
  let p = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > directory.length || directory.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new ZipError('The zip file\'s table of contents is damaged.')
    }
    const nameLength = directory.readUInt16LE(p + 28)
    const extraLength = directory.readUInt16LE(p + 30)
    const commentLength = directory.readUInt16LE(p + 32)
    entries.push({
      flags: directory.readUInt16LE(p + 8),
      method: directory.readUInt16LE(p + 10),
      crc: directory.readUInt32LE(p + 16),
      compressedSize: directory.readUInt32LE(p + 20),
      size: directory.readUInt32LE(p + 24),
      localOffset: directory.readUInt32LE(p + 42),
      name: directory.subarray(p + 46, p + 46 + nameLength).toString('utf8')
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Where an entry lands under `root`, or a ZipError when it would escape it. */
export function zipEntryTarget(root: string, name: string): string {
  const normalised = name.replace(/\\/g, '/')
  if (normalised.startsWith('/') || /^[a-zA-Z]:/.test(normalised) || normalised.split('/').includes('..')) {
    throw new ZipError(`The zip file contains an unsafe path (${name}).`)
  }
  const base = resolve(root)
  const target = resolve(base, normalised)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ZipError(`The zip file contains an unsafe path (${name}).`)
  }
  return target
}

/** Counts bytes and computes CRC-32 as the data streams past. */
class Checksum extends Transform {
  crc = 0
  bytes = 0
  _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.crc = crc32(chunk, this.crc)
    this.bytes += chunk.length
    done(null, chunk)
  }
}

/** Extract every entry of `zipPath` into `targetDir` (created if needed). */
export async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  const file = await open(zipPath, 'r')
  try {
    const { size: fileSize } = await file.stat()
    const entries = await centralDirectory(file, fileSize)
    await mkdir(targetDir, { recursive: true })
    for (const entry of entries) {
      const target = zipEntryTarget(targetDir, entry.name)
      if (entry.name.endsWith('/')) {
        await mkdir(target, { recursive: true })
        continue
      }
      if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted, which is not supported.`)
      if (entry.method !== 0 && entry.method !== 8) {
        throw new ZipError(`${entry.name} uses an unsupported compression method (${entry.method}).`)
      }
      const header = await readAt(file, entry.localOffset, 30)
      if (header.length < 30 || header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        throw new ZipError(`The zip entry ${entry.name} is damaged.`)
      }
      const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
      await mkdir(dirname(target), { recursive: true })
      const checksum = new Checksum()
      if (entry.compressedSize === 0) {
        await writeFile(target, '')
      } else {
        const source = file.createReadStream({
          start: dataStart,
          end: dataStart + entry.compressedSize - 1,
          autoClose: false
        })
        if (entry.method === 8) await pipeline(source, createInflateRaw(), checksum, createWriteStream(target))
        else await pipeline(source, checksum, createWriteStream(target))
      }
      if (checksum.bytes !== entry.size || (checksum.crc >>> 0) !== entry.crc) {
        throw new ZipError(`${entry.name} failed its integrity check; the zip file is damaged.`)
      }
    }
  } finally {
    await file.close()
  }
}
