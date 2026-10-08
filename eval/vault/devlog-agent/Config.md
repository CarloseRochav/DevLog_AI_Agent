---
title: Config
tags:
  - config
---

# Config

## Required Settings

Before deployment the process needs QUEUE_NAME and PAYLOAD_CONTAINER. The worker reads both values at startup. Missing either value stops the process before it polls for work. QUEUE_NAME selects the queue the worker reads, and PAYLOAD_CONTAINER selects where payloads are read from. These two settings are required together. A default is not applied when one of them is absent.
