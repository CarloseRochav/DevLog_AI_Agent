---
title: Deployment
tags:
  - deployment
---

# Deployment

## Startup Check

Deployment starts the worker only after QUEUE_NAME and PAYLOAD_CONTAINER are present. The startup check reads those two settings and exits if one is missing. The release does not begin polling until the check passes. There is no second stage that fills in a missing value. The same check runs in every environment. A failed check prints the missing setting name and stops.
