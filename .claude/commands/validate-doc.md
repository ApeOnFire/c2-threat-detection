---
name: validate-doc
description: Validate a specific guide against current codebase
---

Usage: `/validate-doc <filename>`

Validate the specified documentation file:

1. **Read document** and its frontmatter from docs/guides/

2. **Check based on type**:
   - **Architecture**: Verify file paths exist, component/function names exist in codebase
   - **Operations**: Verify commands/queries exist in codebase, file paths correct
   - **Reference**: Verify commands correct, file paths correct
   - **Strategy**: Verify examples reference files/components that exist

3. **Report findings**:

## Validation Report: [filename]

### Verified (✓)
[List what was confirmed correct]

### Potentially Outdated (⚠️)
[List suspicious items that might be outdated]

### Definitely Incorrect (❌)
[List confirmed incorrect items]

### Validation Limitations (ℹ️)
- Did NOT execute SQL queries (cannot verify they run correctly)
- Did NOT test shell commands (cannot verify they work)
- Did NOT validate function signatures match descriptions
- Referenced database tables/columns not checked (requires DB access)

To validate these items, user permission is required.

---

4. **If user approves**: Make surgical updates to fix incorrect items

**Limitations**:
- Do NOT run database queries without explicit permission
- Do NOT execute shell commands without explicit permission
- Do NOT rewrite entire documents
- Do NOT change structure or add new sections

See docs/DOCUMENTATION.md for validation standards.
