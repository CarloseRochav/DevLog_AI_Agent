---
title: Indexer
tags:
  - indexer
---

# Indexer

## Content Hash

The indexer skips unchanged files by comparing a SHA-256 content hash of the raw file bytes. When the hash matches the stored hash, the file is left as it is and no new work is queued. A different hash means the file changed and the indexer processes it again. The comparison uses the full hash, not the file size and not the modified time. Unchanged files stay out of the queue. This skip is the only reason a file is ignored after it has been seen once.
