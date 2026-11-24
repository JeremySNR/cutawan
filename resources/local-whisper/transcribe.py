"""Local word-timestamp transcription. Dependencies/models are installed explicitly."""
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

job = json.load(sys.stdin)
model_path = Path(job.get("modelPath") or "")
if not (model_path / "model.bin").is_file():
    raise RuntimeError("Select a downloaded faster-whisper model folder containing model.bin.")

# Keep Windows CUDA libraries available for the lifetime of the process.
handles = []
if sys.platform == "win32":
    for entry in sys.path:
        for directory in (Path(entry) / "nvidia").glob("*/bin"):
            handles.append(os.add_dll_directory(str(directory)))
            os.environ["PATH"] = str(directory) + os.pathsep + os.environ.get("PATH", "")

import ctranslate2
from faster_whisper import WhisperModel, decode_audio

SAMPLE_RATE = 16000


def load_audio(path):
    """16 kHz mono float32 samples, decoded by Cutawan's bundled ffmpeg.

    faster-whisper decodes with PyAV, and PyAV 19 removed an argument
    faster-whisper 1.2.1 passes (issue #82), so every install made after that
    release failed on its first file. Decoding here keeps transcription
    independent of whichever PyAV pip picked. Without an ffmpeg path (an
    older app), faster-whisper's own decoder is used as before.
    """
    ffmpeg = job.get("ffmpegPath")
    if not ffmpeg:
        return decode_audio(path, sampling_rate=SAMPLE_RATE)
    import numpy as np
    raw = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if raw.returncode != 0:
        raise RuntimeError("ffmpeg could not decode the audio: " + raw.stderr.decode(errors="replace")[-500:])
    return np.frombuffer(raw.stdout, dtype=np.float32).copy()


if "--check" in sys.argv:
    # Decode a moment of silence the way a real job does, so a broken audio
    # stack shows at setup rather than on the first file.
    if job.get("ffmpegPath"):
        probe = subprocess.run(
            [job["ffmpegPath"], "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
             "-t", "0.1", "-f", "f32le", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
        if probe.returncode != 0 or not probe.stdout:
            raise RuntimeError("Cutawan's ffmpeg could not decode audio for local Whisper.")
    print(json.dumps({"ready": True}))
    sys.exit(0)


def mlx_model():
    """The Apple Silicon GPU copy installed beside the CPU model, if usable."""
    if sys.platform != "darwin" or platform.machine() != "arm64":
        return None
    folder = Path(str(model_path) + "-mlx")
    if not (folder / "config.json").is_file() or not any(folder.glob("weights.*")):
        return None
    try:
        import mlx_whisper  # noqa: F401
    except ImportError:
        return None
    return folder


def transcribe_mlx(folder):
    """~3x faster than CPU int8 on an M1 with no loss against a large-v3-turbo reference.

    faster-whisper's Silero VAD picks the speech regions, as its vad_filter
    does on the CPU path, so silence cannot become hallucinated text.
    """
    import mlx_whisper
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    audio = load_audio(job["path"])
    speech = get_speech_timestamps(audio, VadOptions())
    duration = len(audio) / 16000
    result = {"language": job.get("language") or "", "duration": duration, "text": "", "words": [], "segments": []}
    if not speech:
        return result
    clips = [t for chunk in speech for t in (chunk["start"] / 16000, chunk["end"] / 16000)]
    output = mlx_whisper.transcribe(
        audio, path_or_hf_repo=str(folder), language=job.get("language") or None,
        word_timestamps=True, condition_on_previous_text=False, clip_timestamps=clips,
        hallucination_silence_threshold=2.0, initial_prompt=job.get("prompt") or None)
    result["language"] = output.get("language") or result["language"]
    for index, segment in enumerate(output["segments"]):
        result["text"] += segment["text"]
        result["segments"].append({"id": index, **{key: segment.get(key) for key in
            ["start", "end", "text", "avg_logprob", "no_speech_prob", "compression_ratio"]}})
        result["words"].extend({"word": word["word"], "start": word["start"], "end": word["end"]}
                               for word in segment.get("words") or [])
    return result


def transcribe_cpu():
    gpu = ctranslate2.get_cuda_device_count() > 0
    model = WhisperModel(str(model_path), device="cuda" if gpu else "cpu",
                         compute_type="float16" if gpu else "int8", local_files_only=True)
    segments, info = model.transcribe(
        load_audio(job["path"]), language=job.get("language") or None, beam_size=5,
        word_timestamps=True, vad_filter=True, condition_on_previous_text=False,
        initial_prompt=job.get("prompt") or None)
    result = {"language": info.language, "duration": info.duration,
              "text": "", "words": [], "segments": []}
    for segment in segments:
        result["text"] += segment.text
        result["segments"].append({key: getattr(segment, key) for key in
            ["id", "start", "end", "text", "avg_logprob", "no_speech_prob", "compression_ratio"]})
        result["words"].extend({"word": word.word, "start": word.start, "end": word.end}
                               for word in segment.words or [])
    return result


folder = mlx_model()
print(json.dumps(transcribe_mlx(folder) if folder else transcribe_cpu()))
