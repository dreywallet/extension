# Drey 0.14.8 Store notes

## What's new

This release strengthens transaction completion checks so uncertain broadcast
results remain recoverable instead of being treated as final.

Existing send, receive, activity, Ordinals, website connection, and batch-review
flows are unchanged. This release adds no permissions, prompts, or user steps.

## Reviewer focus

- Successful broadcasts are accepted only when the gateway response matches the
  exact reviewed transaction and network state.
- Uncertain or inconsistent results retain the existing pending-transaction
  recovery path.
- Explicit gateway rejections continue to show through the existing error flow.
- Existing permissions and transaction review interactions remain unchanged.
