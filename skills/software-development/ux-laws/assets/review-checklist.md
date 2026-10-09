## UX review checklist

Answer every item with the screen or component it concerns, or mark it N/A and say why.
Each question asks about a defect, so a "yes" is a finding to fix.

- [ ] Hick: Is there a decision point where the user must weigh more than seven options?
- [ ] Fitts: Is any target smaller than 44 x 44 px or closer than 8 px to its neighbour, or is the main action far from where the user just acted?
- [ ] Jakob: Is there a control that follows no recognised convention and has no recorded reason?
- [ ] Proximity: Is the space between groups less than twice the space inside them anywhere?
- [ ] Miller: Is there a flat list of more than seven items with no grouping, search, sort or filter?
- [ ] Doherty: Does any input take longer than 100 ms to show a response, or any operation over 1 s run without progress?
- [ ] Von Restorff: In greyscale, does any screen have no dominant action, or more than one?
- [ ] Serial Position: Is an important item buried in the middle of a menu or list?
- [ ] Peak-End: Does any flow end without a success screen and a next step, or leave its hardest moment without careful copy and recovery?
- [ ] Zeigarnik: After an interruption, does any multi-step task lose work or hide where the user is and what is left?
- [ ] Prägnanz: Would a first-time viewer fail to name the main regions and action after one second?
- [ ] Similarity: Are there elements that look the same but act differently, or act the same but look different?
- [ ] Uniform Connectedness: Does any container hold an unrelated item, or leave out a related one?
- [ ] Tesler: Is the user asked for a value the system could default, infer or remember?
- [ ] Postel: Does any field reject a reasonable variant, any error omit the fix, or any destructive action lack undo or confirmation?
- [ ] Parkinson: Could a field or step on the main path be removed without changing the result?
- [ ] Occam: Is there a visible element that serves no task on this screen?
- [ ] Pareto: Does a rarely used feature hold a prominent place, or is the usage claim backed by neither data nor a stated assumption?
- [ ] Goal-Gradient: Does displayed progress ever differ from the work actually completed?
- [ ] Chunking: Is there an unbroken code or number over about seven characters, or a long block of text without headings?

Settle conflicts between items with the tensions table in `references/ux-laws.md#tensions`.
