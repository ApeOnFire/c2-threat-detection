---
name: ingest-doc
description: Migrate existing documentation to standardized format
---

Usage: `/ingest-doc <file-path>`

Migrate an existing documentation file to the standardized format defined in docs/DOCUMENTATION.md. This command analyzes the document, proposes a migration strategy, and executes with user approval.

## Process Overview

1. **Analyze** - Read document, detect type(s), identify issues
2. **Propose** - Present findings and migration recommendations
3. **Approve** - Get user decision on approach
4. **Execute** - Perform migration with information preservation
5. **Update** - Update INDEX.md and cross-references

**Critical**: This is a conversation, not a batch operation. Always get approval before making changes.

---

## Analysis Phase

### 1. Read and Understand

Read the entire document first. Note:
- Current structure and sections
- Apparent type(s) based on content
- Line count
- Existing organization patterns

**Also read INDEX.md** to understand the full documentation landscape:
- What other documents exist
- How they're categorized
- Potential relationships or overlaps
- Whether combining with existing docs might make sense

### 2. Type Detection

Identify document type(s) based on content:

**Architecture indicators:**
- System design explanations
- Component descriptions
- Data flow diagrams
- Architectural decisions
- "Why" explanations

**Operations indicators:**
- Step-by-step procedures
- Commands and queries
- Configuration instructions
- Troubleshooting guides
- "How to" content

**Reference indicators:**
- Command lists
- API specifications
- Schema definitions
- Quick lookup tables
- Specifications without explanation

**Strategy indicators:**
- Principles and values
- Guidelines and recommendations
- Brand/product direction
- UX philosophy
- "What we believe" statements

**Mixed signals**: Document may contain multiple types if it covers both "why built this way" AND "how to use it"

### 3. Identify Issues

Check for:
- **Size**: >1500 lines suggests split needed
- **Mixed concerns**: Contains multiple document types
- **Missing structure**: Lacks sections required by type (see templates in docs/guides/TEMPLATES/)
- **Frontmatter**: Missing or incomplete
- **Relationships**: Related documents not identified

---

## Decision Framework

### When to Split

**Split if:**
- Document >1500 lines
- Clearly contains multiple types (e.g., architecture + operations)
- Contains distinct systems/features that could be separate docs
- User would benefit from focused documents

**How to split:**
- Analyze natural boundaries (system components, feature areas)
- Propose filenames following existing convention
- Show proposed content distribution
- Identify new cross-references needed

**Example split proposal:**
```
Current: anthropic-processing-comprehensive.md (1800 lines, mixed)

Proposed split:
1. anthropic-processing-architecture.md (900 lines, Architecture)
   - Sections 1-4: Overview, decisions, components, flows
2. anthropic-processing-operations.md (900 lines, Operations)
   - Sections 5-8: Setup, queries, troubleshooting, examples

New cross-references:
- Each doc links to the other in related_docs
- INDEX.md updated with both entries
```

### When to Combine

**Flag for interactive discussion if:**
- Multiple small docs (<500 lines each) cover same system
- Docs are tightly coupled with excessive cross-references
- User would benefit from unified view
- Combined length would be <1500 lines

**This is rare and complex** - handle conversationally with the user rather than following prescriptive steps. Present the possibility in your analysis and discuss the best approach interactively.

### When to Restructure (1:1 Migration)

**Restructure if:**
- Document is single type and <1500 lines
- Just needs section reorganization
- Frontmatter addition sufficient

**This is the most common case.**

---

## Presentation Format

After analysis, present findings in this format:

```markdown
## Analysis: [filename]

**Size**: [line count] lines
**Detected Type(s)**: [types with confidence]
**Current Structure**: [brief section list]

**Issues Identified**:
- [issue 1]
- [issue 2]

**Recommendation**: [Split/Combine/Restructure]

[Detailed recommendation with rationale]

**Proceed? (y/n)**
```

Wait for user approval before continuing.

---

## Execution Guidelines

### Information Preservation (CRITICAL)

**Never lose information.** When restructuring:
- Preserve all content from original
- Keep code examples, diagrams, tables intact
- Maintain inline links and references
- Preserve any historical notes or version info

**If uncertain about content placement**, include it with a comment like:
```markdown
<!-- TODO: Verify this section placement -->
```

### Restructuring Steps

1. **Reference the appropriate template** from docs/guides/TEMPLATES/
2. **Map content to template sections**:
   - Identify where each part of old doc fits in new structure
   - Note any content that doesn't fit standard sections
3. **Create frontmatter**:
   - type: [detected type]
   - status: Active (unless told otherwise)
   - last_updated: [today's date YYYY-MM-DD]
   - last_validated: [today's date YYYY-MM-DD]
   - related_docs: [identify from content and existing docs]
   - prerequisites: [identify from content]
   - approx_tokens: [estimate based on line count - see DOCUMENTATION.md]
4. **Restructure content**:
   - Add required sections per template
   - Move content to appropriate sections
   - Add section headings if missing
   - Keep existing good structure where it matches template
5. **Improve scannability**:
   - Add tables where helpful (Quick Reference, Command lists)
   - Use consistent formatting for code blocks
   - Add section summaries if sections are long
6. **Write updated file** to original location (or new locations if split)

### Splitting Steps

1. **Create two (or more) new files** with appropriate names
2. **Distribute content** based on type
3. **Add frontmatter** to each new file
4. **Add cross-references** in related_docs between split files
5. **Remove or deprecate** original file (ask user preference)

### What NOT to Do

**Don't:**
- Rewrite content in different style (preserve voice)
- Remove information you don't understand
- Add speculative future plans
- Change terminology used in original
- Over-organize content that's intentionally informal

**Do:**
- Preserve the author's voice and style
- Keep specific examples and real data
- Maintain any project-specific terminology
- Focus on structure, not content changes

---

## Update Procedures

After migrating document(s):

### 1. Update INDEX.md

Add or update entries in docs/guides/INDEX.md:
- Use guide filename
- Set correct Type
- Write 2-4 sentence summary of contents (focus on WHAT it contains, not when to use)
- If deprecated old doc, use ~~strikethrough~~ and [Deprecated] prefix

### 2. Update Cross-References

- Check related_docs in frontmatter
- Verify all referenced files exist
- Add reciprocal references (if A references B, consider if B should reference A)
- Update prerequisites chain if needed

### 3. Verify Relationships

- Read related documents briefly
- Confirm relationships make sense
- Flag any circular dependencies
- Note if document should be prerequisite for others

---

## Safety Checks

Before finalizing:

1. **Verify all original content is preserved** (do a diff check in your mind)
2. **Confirm frontmatter is complete and valid**
3. **Check all links and references work**
4. **Validate against template structure** for the type
5. **Ensure INDEX.md is updated**
6. **Report what was changed** to user

**Present summary**:
```markdown
## Migration Complete: [filename]

**Actions taken**:
- [action 1]
- [action 2]

**Files created/modified**:
- [file 1]
- [file 2]

**INDEX.md updated**: [yes/no]

**Verification needed**:
- [any items user should check]
```

---

## Edge Cases

**Document is already compliant**:
- Report this to user
- Ask if they want any improvements anyway

**Document path doesn't exist**:
- Report error
- Suggest checking path or running from docs/guides/

**Documentation system not found**:
- Check for docs/DOCUMENTATION.md
- If missing, this command can't work (system not set up)

**Ambiguous type**:
- Present evidence for each possible type
- Ask user to clarify intended type
- Explain implications of each choice

---

See docs/DOCUMENTATION.md for complete standards and docs/guides/TEMPLATES/ for structure examples.
