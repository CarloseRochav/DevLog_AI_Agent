---
title: Queue Worker
tags:
  - worker
---

# Queue Worker

## Procedure Call

The queue worker calls sp_ProcessBatch with a table-valued parameter that holds the batch rows. The procedure name is sp_ProcessBatch. The worker opens one database connection, passes the rows, and commits when the procedure returns zero. A non-zero return is a failed attempt. No other component calls sp_ProcessBatch. The call happens after the payload has been loaded and checked. The worker logs the return code next to the batch id.

## Content Hash

After the procedure returns zero, the worker stores the payload content hash beside the batch id. The hash identifies the bytes that were processed. A later reader can compare a new payload with this stored hash. The hash is not a file name and it is not a message id. It stays with the batch record for the life of that batch.
