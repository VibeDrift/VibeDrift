# CLI backlog

- **`watch` renderer shows signed-out copy while authenticated** (v0.14.8): watch
  output includes the "Sign in with `vibedrift login`…" hint and free-tier deep
  tease even on a logged-in session. Fix the auth-state branch in the renderer.
- **Default `--deep` output should surface the AI results inline**: the concise
  deep render shows "AI fix prompts ready" + the dashboard link, but the
  coherence audit, AI-validated findings, and intent-mismatch checks only
  appear with `--format terminal`. Add a short AI summary (coherence grade +
  top finding) to the default deep render.
