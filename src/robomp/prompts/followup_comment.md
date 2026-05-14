# Follow-up on {{repo.full_name}}#{{inbound.number}} ({{inbound.kind}})

A new comment arrived on this {{inbound.kind}} thread (originating issue
#{{issue.number}}). Current PR state: `{{state.pr_status}}`.

## New comment by @{{comment.author}} ({{comment.created_at}})

{{comment.body}}

---

Decide what to do:

- If the reporter provided new repro information, re-run the reproduction
  (use `repro_record`) and comment with the outcome.
- If the reporter requested a change to the PR, amend the branch and push.
  Do not open a second PR — push to `{{workspace.branch}}` and reply with a
  short `gh_post_comment` describing what changed.
- If the reporter confirmed the fix or asked an unrelated question, answer
  with a single `gh_post_comment`. Do not modify code unnecessarily.
- If the comment is from a bot or has no actionable content, no-op.

Reuse the recorded session state; do not restart from scratch.
