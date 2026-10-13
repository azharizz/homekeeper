import test from "node:test";
import assert from "node:assert/strict";
import { completeGuideSpeech, replaySourceTime } from "../web/guide-replay-state.js";

const metadata = { start_seconds: 79, end_seconds: 83, source_seconds_per_second: 0.25 };

test("encoded playback maps to bounded original source time", () => {
  for (const [playback, expected] of [[0, 79], [8, 81], [16, 83], [-1, 79], [20, 83]])
    assert.equal(replaySourceTime(metadata, playback), expected);
});

test("only successful speech completion in the current visible generation can continue", () => {
  const voice = {}, utterance = { current: voice };
  let resumes = 0;
  const resume = () => { resumes++; };
  assert.equal(completeGuideSpeech(2, 2, true, false, voice, utterance, resume), true);
  assert.equal(resumes, 1);
  assert.equal(utterance.current, null);
  assert.equal(completeGuideSpeech(2, 2, true, false, voice, utterance, resume), false);
  assert.equal(resumes, 1, "duplicate native completion cannot replay the continuation");

  for (const [currentId, active, hidden, currentVoice] of [
    [3, true, false, voice], // Stop or a new action increments the epoch.
    [2, false, false, voice], // Navigation unmounts the guide.
    [2, true, true, voice], // Backgrounding prevents continuation even before cleanup.
    [2, true, false, null], // Speech errors, unsupported speech, or cancellation clear the utterance.
    [2, true, false, {}], // A newer utterance replaced this one.
  ]) {
    const current = { current: currentVoice };
    assert.equal(completeGuideSpeech(2, currentId, active, hidden, voice, current, resume), false);
    assert.equal(current.current, currentVoice);
  }
  assert.equal(resumes, 1);
});
