# Covenant

A Forge app for Jira, built for Atlassian Codegeist 2026.

Attach a contract (a text PDF or DOCX) to a Jira work item and Covenant pulls out its obligations. Each obligation comes with the verbatim clause and page it came from. After a person reviews them, Covenant creates child work items with due dates. Before a renewal notice window closes, it opens a decision item.

The model only reads the contract. Deterministic, tested code works out every date. Every quote must appear word for word in the contract. Anything doubtful goes to a person instead of being guessed.

Status: in development. Setup steps and screenshots come with the submission.

## Layout

- `packages/core`: the schema, extractor, quote verifier, second-pass critic and date engine, in pure TypeScript.
- `src`: the Forge app.
- `eval`: scores the core against CUAD contracts; see [eval/README.md](eval/README.md) and [eval/report.md](eval/report.md).
- `samples/fictional`: an invented contract for tests and demos.

```bash
npm install
npm run check   # type-check everything and run the tests
```

## Credits

The evaluation uses CUAD v1, the Contract Understanding Atticus Dataset, by The Atticus Project, licensed under CC BY 4.0 (https://doi.org/10.5281/zenodo.4595826).
No CUAD contract ships with the app.
