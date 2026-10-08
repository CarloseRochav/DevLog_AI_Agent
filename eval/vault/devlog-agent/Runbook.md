---
title: Runbook
tags:
  - runbook
---

# Runbook

## First Response

The first step in an incident is to read the oldest batch id from the alert and write that id into the incident notes. Do not restart the worker until that batch id is recorded. The second step is to decide whether the batch should be replayed. This first step exists so the id is not lost if the alert clears. The operator follows this order. Skipping the first step is a failed response.
