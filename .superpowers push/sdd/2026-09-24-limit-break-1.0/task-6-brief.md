### Task 6: Default resume prompt

- Change the default `resumePrompt` (`package.json` contribution default and `src/config.ts` fallback) to exactly:
  `[Limit Break] I hit my usage limit while you were working, but it has reset now. Please continue from where you left off.`
- Update the integration defaults test (`test/integration/extension.itest.ts`) and any unit test that pins the old default. The README settings table is handled in Task 9.

