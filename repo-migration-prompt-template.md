# Repo Migration Prompt Template — Runtime-Only Clone

Use this template whenever you want to create a clean new repo from an existing one, carrying over only what's needed to run the application.

---

## The Prompt

I want to create a clean copy of my project at [NEW REPO PATH]. The goal is a repo that contains ONLY what's needed to build and run the application in production. Nothing else.

Here are my rules:

**INCLUDE — files that are part of the runtime:**
- Source code (app/, lib/, components/, hooks/, styles/, public/)
- Configuration files (package.json, tsconfig.json, next.config.*, tailwind.config.*, postcss.config.*, .eslintrc.*, middleware.ts)
- Database schema (combine all migration files into ONE clean schema file)
- Environment template (.env.example with keys blanked)
- Essential type definitions
- Inngest/background job functions (if applicable)

**EXCLUDE — files that are NOT needed to run:**
- Backup directories (_backup/, _old/, _archive/, etc.)
- Documentation and notes (docs/, *.md except README.md)
- Legacy/deprecated code paths that are not imported anywhere
- Dev-only scripts and utilities (scripts/, unless referenced in package.json)
- Individual migration files (replace with single consolidated schema)
- Test data, seed files, mock data
- IDE-specific files (.vscode/, .idea/)
- Build artifacts (.next/, node_modules/, dist/)
- Screenshots, design files, assets not referenced in code

**HOW TO DECIDE EDGE CASES:**
If you're unsure whether a file is runtime-necessary, trace it:
1. Is it imported by any file in app/ or lib/?
2. Is it referenced in package.json scripts?
3. Is it required by the build process (next build)?
4. Is it loaded at runtime by middleware or API routes?

If the answer to ALL four is no, exclude it.

**BEFORE YOU START COPYING:**
1. List every directory and file you plan to exclude, with your reasoning
2. Flag any files you're uncertain about — ask me, don't guess
3. If there are multiple versions of the same feature (e.g., editor-v1, editor-v2, modular-editor), ask me which one is active

**AFTER COPYING:**
1. Verify the project builds with no errors
2. Initialize a fresh git repo
3. Create a single initial commit
4. Do NOT push until I confirm the remote
