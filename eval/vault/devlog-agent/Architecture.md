---
title: Architecture
tags:
  - worker
  - queue
---

# Architecture

The batch system accepts work from callers, keeps each payload as its own object, and processes one batch at a time. The pieces are the listener, the queue, and the worker that pulls messages. This note is the map of that flow. Operators start here when they need to see how a batch moves from submission to a finished record.

## Queue Worker

The queue worker retries failed batches. After a batch fails, the worker waits and then runs that same batch again. It records the batch id and the failure reason on every attempt. The worker keeps going until the retry policy says to stop. A successful run removes the message from the queue so the same batch is not picked up twice. The worker does not invent a new batch id during a retry. It uses the id that arrived with the original message.

## Data Flow

A caller submits a batch to the listener. The listener stores the payload and enqueues a message that carries the batch id. The queue worker reads that message, loads the payload, and processes it. When processing finishes, the message leaves the queue. This path is the only way a batch reaches the worker.
