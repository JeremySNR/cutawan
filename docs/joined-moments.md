# Joining separate moments (beta)

By default every clip is one continuous stretch of the source. With **Join
separate moments** ticked on the setup screen, the AI may also propose a clip
made of two or three stretches played back to back: a question and its answer
with the tangent between them removed, a setup and the payoff that arrives a
few minutes later, a claim and the best evidence for it.

It is off by default and marked beta. It has been tested with scripted model
replies and with real exports; it has not yet been compared against continuous
clips on real footage with a live provider.

## What a joined clip is

Nothing new in the project file. A clip is a trim (`edit.start` to `edit.end`)
with ranges cut out of it (`edit.cuts`); a joined clip is a trim that runs from
the start of its first moment to the end of its last, with the stretch between
them cut. Preview, captions, auto zoom and export already follow a clip's cuts,
so they follow a join the same way. `clip.stitch` records what the AI proposed
and why, for the label.

That means everything the editor can do to a cut it can do to a join: click the
cut to put the skipped stretch back, drag a red edge to let a moment run longer
or end sooner, undo either.

## How a join is chosen and checked

1. **Selection.** The selection request asks for each clip as an ordered list
   of one to three segments, with rules: most clips should be one segment; a
   join must remove something specific and at least several sentences long; the
   lines either side must follow as if nothing was removed; and a join must
   never change what a speaker meant.
2. **Landing.** Each segment is landed on sentence boundaries with the same
   pre- and post-roll as a continuous clip. Segments a breath apart are merged
   back into one moment. A joined clip is taken as proposed or dropped: one
   with a part under three seconds, more than three parts, or more played time
   than the length cap is not trimmed to fit.
3. **Join review.** A separate request judges every join on two questions:
   *seamless* (would a listener notice anything missing?) and *faithful* (does
   the joined clip mean what the speakers meant?). It sees the lines that play
   before the join, the lines that were skipped, and the lines that play after.
   A joined clip is kept only on an explicit pass on both. A clip with no
   verdict is dropped, and if the review request fails, all joined clips are
   dropped and the continuous ones are kept.
4. **Ending and opening reviews** then run as usual, on the text that plays.
   They can move a joined clip's end within its last moment and its start
   within its first, never across a join.

## Limits

- A join can only be proposed by a request that sees both moments. Videos
  under about twenty minutes of speech are analysed in one request, so any two
  moments can be joined. Longer videos are analysed in twelve-minute windows
  that overlap by six minutes when joining is on, so a joined clip whose first
  moment starts and last moment ends within six minutes is always seen whole
  by some request (a skip of up to about five minutes). Moments further apart
  than a window are never joined. The wider overlap roughly doubles the text sent for selection.
- Segments always play in source order.
- The review reads text. It cannot tell that two lines were spoken by
  different people unless the words show it, and it cannot see a change of
  shot, clothing or setting. Watch a joined clip across its join before
  exporting it. Joined clips are labelled on their card and in the editor for
  this reason.
- The picture cuts at a join. Auto zoom treats it like any other cut and
  changes zoom level across it, which reads as a deliberate edit when both
  moments are the same shot and less so when they are not.
- Visual-payoff repair, which extends a clip into the footage after it, does
  not run on joined clips.
- The ChatGPT sign-in route adds one request per run for the join review.

## Cost of the footage between

Two moments five minutes apart make a five-minute trim. Framing analysis,
loudness measurement and export read only the stretches that play: cuts
shorter than fifteen seconds are read through, longer ones are skipped with a
separate seek. If the skipped stretch is restored in the editor, the clip is
marked for framing analysis again, since nothing has looked at that footage.
