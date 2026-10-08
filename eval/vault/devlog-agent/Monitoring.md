---
title: Monitoring
tags:
  - monitoring
---

# Monitoring

## Stuck Queue

Monitoring detects a stuck queue when the oldest visible message is older than ten minutes. The check runs every minute and raises an alert named QueueStuck. The alert includes the batch id of that oldest message and the age in minutes. A queue that drains inside ten minutes does not raise QueueStuck. The check only reads message ages. It does not restart anything and it does not move messages.
