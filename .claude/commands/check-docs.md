---
name: check-docs
description: Health check documentation in docs/guides/
---

Run a health check on all documentation in docs/guides/:

1. **Read all guides** in docs/guides/ (exclude INDEX.md and TEMPLATES/)

2. **For each guide, validate**:
   - Frontmatter exists and contains all required fields
   - `last_validated` date (flag if >90 days old)
   - `status` field value (note if Draft or Deprecated)
   - Line count (flag if >1500)
   - All `related_docs` files exist
   - All `prerequisites` files exist

3. **Check INDEX.md**:
   - Compare listed guides vs actual files in docs/guides/
   - Flag if guides missing from INDEX.md
   - Flag if INDEX.md lists non-existent guides

4. **Report findings** in this format:

## Documentation Health Report

### Validation Issues
| Document | Issue | Recommendation |
|----------|-------|---------------|
| [filename] | [issue description] | [what to do] |

### Size Warnings
| Document | Lines | Recommendation |
|----------|-------|---------------|
| [filename] | [line count] | Consider splitting |

### Status Notes
| Document | Status | Note |
|----------|--------|------|
| [filename] | [Draft/Deprecated] | [guidance] |

### INDEX.md Status
[✓ or ⚠ with details]

---

**Do not modify any files**. Only report findings.

See docs/DOCUMENTATION.md for validation standards.
