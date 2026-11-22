# Joining separate moments (beta)

By default every clip is one continuous stretch of the source. With **Join
separate moments** ticked on the setup screen, the AI may also propose a clip
made of two or three stretches played back to back: a question and its answer
with the tangent between them removed, a setup and the payoff that arrives
later, a claim and the best evidence for it.

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

1. **Selection.** The transcript is shown to the model one sentence per line,
   each with its line number and its start and end time, and the model answers
   with line numbers, never times. The selection request asks for each clip as
   an ordered list of one to three segments, each a first and last line, with
   rules: most clips should be one segment; a join must remove something
   specific and at least several sentences long; the lines either side must
   follow as if nothing was removed; and a join must never change what a
   speaker meant. Videos with more than about twenty minutes of speech are read
   in overlapping windows, one request each (see Limits).
2. **Repair.** If the answer breaks a rule that can be named (a line number it
   was not shown, a segment that ends before it starts, a joined clip over the
   length cap, a segment under three seconds, more than three segments), one
   follow-up request shows the model its answer and the problems in plain words
   and asks for a corrected list. The corrected list is used only if it has
   no fewer usable clips and fewer problems (or as many, when the first answer
   had nothing usable). There is never a second repair, and
   none on ChatGPT sign-in.
3. **Landing.** Each segment is mapped from its line numbers to the exact start
   of its first sentence and end of its last, with the same pre- and post-roll
   as a continuous clip. Segments a breath apart are merged back into one
   moment. A joined clip is taken as proposed or dropped: one with a part under
   three seconds, more than three parts, or more played time than the length
   ceiling is not trimmed to fit. (Each length setting has a target and a
   ceiling a quarter above it: short 45/56 s, medium 75/94 s, long and auto
   100/125 s. A clip between the two is kept whole and ranked a few points
   lower; past the ceiling it is repaired or dropped.) The one exception is a
   long-range join still over the ceiling after its correction: whole
   sentences are dropped from the end of its first part, then its last, and
   the result faces the join review like any other.
4. **Distant moments.** On a video read in more than one window, an outline of
   the whole video is used to find setups whose payoff lies further away than
   any window reaches (see below). The joined clips it produces join the same
   candidate list as the others before the join review.
5. **Join review.** A separate request judges every join on two questions:
   *seamless* (would a listener notice anything missing?) and *faithful* (does
   the joined clip mean what the speakers meant?). It sees the lines that play
   before the join, the lines that were skipped, and the lines that play after.
   When the transcript has them, each join also states which speaker says the
   line either side of it (from speaker diarization) and whether it crosses a
   topic change (from the local topic detection), so a join that makes two
   people sound like one, or stitches two subjects together, is easy to refuse.
   A joined clip is kept only on an explicit pass on both. A clip with no
   verdict is dropped, and if the review request fails, all joined clips are
   dropped and the continuous ones are kept.
6. **Opening check.** A check without any request (English transcripts only)
   skips throwaway lead-ins such as "Yeah." or "Okay, so." at the start of a
   clip, and marks down a clip whose first sentence leans on something said
   before it ("And...", "That's why..."), saying so in its score reason. On a
   joined clip it only ever moves the start within the first moment.
7. **Ending and opening reviews** then run as usual, on the text that plays.
   They can move a joined clip's end within its last moment and its start
   within its first, never across a join. On a video read in windows, a last
   request scores all candidates side by side so clips from different windows
   rank on one scale.

## Joining moments far apart

The windows that selection reads overlap by six minutes when joining is on, so
two moments up to about five minutes apart are always in front of the same
request, and the selection pass itself can join them. Moments further apart are
found another way:

1. **Mapping.** The transcript is split into parts of about twelve minutes that
   overlap by thirty seconds, and each part gets one request. It returns that
   part's chapters, the threads it leaves open (a question not yet answered, a
   setup, a claim without its proof, an unfinished story) and the moments in it
   that answer, pay off, prove or continue something, each as a range of line
   numbers with a short label.
2. **Matching.** One request reads only those lists, not the transcript, and
   pairs open threads with the later moments that settle them, strongest first.
   Every line number in a mapping reply is checked against the lines that
   request was given, and every pairing must name a thread and a later moment
   that the mapping found; anything else is discarded. If any of these requests fails,
   the run carries on without distant joins.
3. **Proposing.** Pairings that some selection window already held whole are
   left out, since that window could have joined them. Of the rest, the eight
   strongest go into one request that shows, for each pairing, the real numbered
   lines around the first moment and around the second (each range, up to
   twelve lines of it, plus four lines either side, each line with how long it
   plays). For each pairing the model
   returns one joined clip in the same format as the selection pass, or
   declines. The prompt carries the same selection and joining rules and says
   that declining is often the right answer. A clip may use only its own
   pairing's lines and must take a segment from each moment; it is landed with
   the same rules as any other clip. If an answer breaks a rule, one correction
   request follows, as in the selection pass; a clip still over the length
   ceiling after it has whole sentences trimmed (see Landing).

The outline depends only on the transcript and the AI model, not on the
instructions or clip length, so it is saved in the project folder
(`outline-cache`) and reused when clips are generated again. A saved outline is
checked against the current transcript before it is used, and an outline that
failed is never saved.

**Requests.** For speech that spans *S* seconds (more than twenty minutes), the
first run spends ⌈(*S* − 30) / 690⌉ mapping requests, one matching request
(none when nothing was left open) and one proposing request (none when no
pairing is too far apart for a window) plus at most one correction of it. That
is up to 11 + 1 + 2 = 14 extra requests for a two-hour video, and up to 2 on
later runs with the same transcript and model. Joining also widens the overlap
between selection windows to six minutes, so selection itself takes about one
request per six minutes of speech instead of one per twelve (19 windows rather
than 13 for two hours), on every run.
The joined clips it adds are judged by the join review like any other, which
can add one join-review request when the windows produced no joined clips of
their own. Videos read in one request, and runs with joining off, make none of
these requests and keep the narrower window overlap. ChatGPT sign-in makes none of them either: it reads the whole
transcript in one request, so moments of any distance can be joined there, but
only by that one request.

## Limits

- Nearby moments (up to about five minutes apart) are found by the normal
  selection pass. Distant moments are joined only when the outline pairs them:
  a setup whose payoff the outline does not notice, or matches to the wrong
  moment, is not joined, and at most eight distant pairings are tried per run.
  The wider window overlap for nearby joins roughly doubles the text sent for
  selection.
- The outline judges from labels and the proposal from a few dozen lines around
  each moment. Neither sees what is said between the two moments; the join
  review sees an excerpt of it.
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

## Live check (2026-11-22)

Against gpt-5.4-mini on a synthetic 52-minute, two-person podcast transcript
written so that a question at the start ("what was the worst week?") is
answered only near the end. Six runs while the feature was built:

- The outline paired the opening question with the right payoff (the story
  told at minute 44 to 48) in four of the six runs. In the others it paired it
  with an earlier mention of the same subject, which the joining step then
  could not turn into a clip.
- Asked for a joined clip, the model took far too much of each moment
  (188 to 303 seconds against a 100 to 125 second limit), and one correction
  only brought it to 122 to 186 seconds. Showing each line's length and the
  per-part budget helped but did not fix it; the sentence-trimming fallback is
  what produced a clip.
- In the final run that clip (0:42 to 0:54, then 47:12 to 49:42) passed the
  join review and ranked second of 35. It runs 124 seconds, so it carries the
  "runs long" note.
- Selection by line number held: no clip landed mid-sentence. About two in
  three windows needed the one correction request, nearly always for clips
  over the length limit.

One synthetic transcript is not a measure of how often joins are good on real
footage; treat these as smoke results.

