## UX design principles

Follow these rules whenever you build or review a user interface. They come from research on how
people see, choose and remember, so they apply whatever the framework, platform or tool.

1. Hick's Law: give each screen one main decision; show no more than about seven options at a decision point and move the rest to "more", search or a later step.
2. Fitts's Law: make touch and click targets at least 44 x 44 px (never under 24 x 24 CSS px) with 8 px or more between them; put the main action where the pointer or hand already is.
3. Jakob's Law: use the patterns people know from other products; a new interaction pattern needs a written reason naming the user benefit.
4. Law of Proximity: keep the space between groups at least twice the space inside a group; labels sit nearest their own field.
5. Miller's Law: present information in labelled groups of three to five; give any list over about seven items grouping, search, sorting or filtering.
6. Doherty Threshold: respond visibly to every input within 100 ms, finish routine operations within 1 s, show progress for anything slower; use optimistic updates and skeleton screens while waiting on the network.
7. Von Restorff Effect: let exactly one action dominate each screen, set apart by shape, size or weight as well as colour so it survives greyscale.
8. Serial Position Effect: place the most important items at the start and the end of menus and lists; the middle holds the least important.
9. Peak-End Rule: end every flow on a deliberate success screen that confirms the result and offers a next step; give the hardest moment the most careful copy and recovery.
10. Zeigarnik Effect: show step count, current position and remaining work in multi-step tasks; save unfinished work so it can be resumed.
11. Law of Prägnanz: use plain, aligned layouts on a consistent grid with little ornament; simplify any layout that needs explaining.
12. Law of Similarity: give one function one appearance across the product; things look alike only if they behave alike.
13. Uniform Connectedness: group related fields and controls inside one card, outline or tinted panel; join sequences with a line or rail.
14. Tesler's Law: let the system carry the complexity with defaults, inferred and remembered values; keep advanced settings optional, never remove what the task needs.
15. Postel's Law: accept reasonable input variants and normalise them; validate inline; make each error name the problem and the fix; make destructive actions undoable or confirmed.
16. Parkinson's Law: use the fewest steps and fields the outcome needs; autofill and remembered values let users finish early.
17. Occam's Razor: take away or relocate anything on screen the current task does not use; between two equally good designs, ship the simpler.
18. Pareto Principle: give the most-used features the most prominent places and shortest paths, based on data or a labelled assumption; keep the rest in menus.
19. Goal-Gradient Effect: show progress and what remains; a head start must reflect real completed work, and progress is never invented.
20. Chunking: split long codes and numbers into short groups and long content into headed sections.

When rules conflict: Tesler limits Hick (relocate needed options, never drop them). Similarity limits Von Restorff (one element stands out, not several). Convention wins over novelty unless a user benefit is stated. Postel governs input and errors; Occam governs presentation. Honesty limits Goal-Gradient. Empirical rules outrank observational ones, which outrank heuristics (Parkinson, Occam, Pareto, Tesler, Postel).
