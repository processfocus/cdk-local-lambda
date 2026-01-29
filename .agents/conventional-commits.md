# Conventional Commits

This repo uses Conventional Commits for commit messages and PR titles.

## Required PR title types

PR title lint enforces these types:

- `feat`
- `fix`
- `chore`
- `refactor`
- `test`
- `vendor`

## Format

```text
<type>: <short imperative summary>

Optional body explaining why/how.
```

Scopes are optional in this repo:

```text
fix(cli): improve error message when config is missing
```

Breaking changes use `!` after type (and optionally scope):

```text
feat!: change default bootstrap stack name
```

## Guidelines

- Summary is imperative, present tense ("add", "fix", "refactor").
- Keep the first line concise; add details in the body.
- Avoid mixing unrelated changes in one commit.
