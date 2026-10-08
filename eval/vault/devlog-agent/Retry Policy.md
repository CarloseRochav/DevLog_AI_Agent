---
title: Retry Policy
tags:
  - retry
---

# Retry Policy

## Attempt Limit

The retry limit is three attempts. A fourth attempt used to apply the same change twice, so the limit stays at three. The count includes the first try. When the third attempt fails, the worker stops. Operators chose three after reading a week of duplicate updates caused by a longer limit. The number is fixed in this policy and is not read from a setting.

## Dead Letter

After three failed attempts the batch is dead-lettered. Dead-lettered batches are stored in the dead-letter container and left for an operator. The worker does not retry a dead-lettered batch. The container holds the payload and the last failure reason. Clearing a dead-lettered batch is a manual step. Automatic deletion of that container is not part of this system.
