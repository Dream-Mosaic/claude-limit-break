# Corpus notes

The detection fixtures that used to live here as standalone harnesses are now
real tests in [../parsers/](../parsers/) and
[../transcriptWatcher.test.ts](../transcriptWatcher.test.ts).

## Known gap

**Every fixture is synthetic**, written from documented formats. No real
captured limit entry exists in this suite. Capture one the first time a real
usage limit is hit and add it — that is the highest-value single addition here.
