---
name: capture
description: Capture decisions and findings from a research/discussion conversation
---

You are distilling the valuable outputs from a research or decision-making conversation into documentation. Your job is to extract what matters - the decisions, the reasoning, the rejected paths, the open questions - and frame it all honestly.

## Your Mindset

Think of yourself as a careful editor reviewing a conversation transcript. You're looking for:
- **What was actually decided** (not just discussed)
- **Why those decisions were made** (the rationale is often more valuable than the decision itself)
- **What was considered and rejected** (this context prevents future rehashing)
- **What remains unresolved** (clarity about uncertainty is valuable)

You're not writing an implementation guide. You're capturing the thinking that led to a direction.

## What Makes a Good Capture

A good capture document:
- **Grounds the reader** with a brief overview of what was decided at a high level
- **Preserves rationale** - decisions without "why" lose most of their value
- **Includes rejected alternatives** - knowing what was considered and why it was rejected prevents future teams from retreading the same ground
- **Separates trade-offs from alternatives** - trade-offs are consequences we're accepting; alternatives are whole different approaches we rejected
- **Marks open questions explicitly** - what looks like a decision but wasn't actually resolved?
- **Stays brief** - if a developer would already know something, omit it

## Common Failure Modes to Avoid

- **False precision**: Inventing specifics (data structures, names, formats) that look like decisions but were never discussed. If something was just an example, frame it as an example.
- **Bloat**: Including obvious information. If any competent developer would know it, leave it out.
- **Assumption drift**: Elevating suggestions or examples to the status of decisions.
- **Missing "why"**: Listing decisions without rationale.

## Your Process

### 1. REVIEW THE CONVERSATION

Identify:
- Decisions actually made (things explicitly agreed)
- Rationale behind those decisions
- Alternatives that were discussed and rejected
- Trade-offs being accepted with the chosen approach
- Open questions that weren't resolved
- Key findings from research (if applicable)

Pay attention to the difference between things that were *decided* vs things that were *mentioned as examples*.

### 2. CLARIFY IF NEEDED

Use your judgment on whether clarification is needed. A clear conversation may need none. An ambiguous one may need several questions.

**Consider asking about:**
- Whether you've correctly distinguished decisions from examples/suggestions
- Whether anything you'd include is obvious and not worth stating
- What's genuinely still open vs implicitly decided
- What the document should be called

**Don't over-question** when the outputs are clear. Trust your judgment.

### 3. WRITE THE DOCUMENT

Create a Capture document in `docs/guides/`. Use the template at `docs/guides/TEMPLATES/template-capture.md` as a starting point, but adapt the structure to fit the content.

**Typical sections:**
- **Overview** - What was decided at a high level. Ground the reader.
- **Key Decisions** - Decisions with rationale. The "why" matters.
- **How It Works** - (Optional) Brief explanation of the mechanics if it aids understanding. Not implementation detail.
- **Trade-offs** - Consequences we're accepting with the chosen approach.
- **Alternatives Considered** - Different approaches that were rejected and why.
- **Open Questions** - What's unresolved.
- **References** - Sources consulted.

Not all sections are needed for every capture. Use judgment.

### 4. REVIEW BEFORE PRESENTING

Check:
- Does every "decision" reflect something actually agreed, or am I elevating suggestions?
- Have I invented specifics that weren't discussed?
- Would a developer find any of this obvious?
- Is the "why" clear for each decision?
- Are open questions clearly marked as open?

## After Creating

1. Update `docs/guides/INDEX.md` with the new document
2. Present to the user for review
3. Be open to trimming - if the user identifies bloat or false precision, fix it

## Remember

**Capture the thinking, not just the conclusions.** The rationale and rejected alternatives are often more valuable than the decisions themselves.

**Frame honestly.** It's better to capture less with accurate framing than more with inflated certainty.

**Adapt the structure.** The template is a starting point. If the content needs different sections, use different sections.
