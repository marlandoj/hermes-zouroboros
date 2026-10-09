# UX laws: principles, checkable rules and their research basis

This document turns twenty findings and rules of thumb about human perception, memory, motor
control and decision making into interface rules that a reviewer or a code-generating agent can
test. Each entry has five parts:

- **Finding.** What the research or the originating author actually showed or claimed, in plain words.
- **Rule.** The design constraint derived from it, with numbers where a number is defensible.
- **Check.** How to verify the rule on a diff, a mockup or a running screen.
- **Sources.** Primary publications first, then the most useful later work.
- **Evidence.** One of three classes, defined below.

Evidence classes:

- **Empirical.** Controlled experiments, replicated, with a measurable effect.
- **Observational.** Field observation, industry measurement or long practitioner experience. Useful, but not a controlled result.
- **Heuristic.** An aphorism or engineering maxim. Treat it as advice; it never settles an argument on its own.

The rules use concrete thresholds so that a check can pass or fail. The thresholds are design
choices informed by the sources, not constants of nature. Where a platform guideline or a WCAG
success criterion sets a number, that number is cited.

---

## 1. Hick's Law (Hick-Hyman Law)

**Finding.** In choice-reaction experiments, the time to respond rose roughly linearly with the
information content of the choice, that is with log2 of the number of equally likely
alternatives. Hyman showed that what matters is information (uncertainty), so unequal
probabilities and practice change the slope.

**Rule.** Each screen has one main decision. A single decision point shows no more than about
seven options; the rest sit behind "more", a search box or a later step. When one option is
recommended, mark it so the user does not have to weigh every alternative equally.

**Check.** Count the options competing at each decision point. Above seven, ask what can be
grouped, defaulted or moved to a second step.

**Sources.** Hick, W. E. (1952). On the rate of gain of information. *Quarterly Journal of
Experimental Psychology*, 4(1), 11–26. Hyman, R. (1953). Stimulus information as a determinant
of reaction time. *Journal of Experimental Psychology*, 45(3), 188–196.

**Evidence.** Empirical for simple choice reaction. Its extension to menus and whole pages is an
extrapolation: familiar users scan or recall instead of choosing afresh, and search tasks follow
other laws. Hiding options that the task needs trades decision time for search time.

## 2. Fitts's Law

**Finding.** Movement time to a target grows with the ratio of its distance to its width, as
log2(2D/W) in Fitts's formulation and log2(D/W + 1) in the Shannon form that HCI uses. Card,
English and Burr confirmed it for the mouse; it holds for touch and pointing devices generally.

**Rule.** Touch and click targets are at least 44 x 44 px, or 48 x 48 dp on Android. Never go
below the WCAG 2.2 minimum of 24 x 24 CSS px. Leave at least 8 px between neighbouring targets.
Put the main action where the hand or pointer already is: after the last field, next to the
current selection. On desktop, screen edges and corners stop the pointer and so behave as very
large targets.

**Check.** Find the smallest interactive element and measure it. Trace the pointer path from the
final field to the submit button; it should be short and unobstructed.

**Sources.** Fitts, P. M. (1954). The information capacity of the human motor system in
controlling the amplitude of movement. *Journal of Experimental Psychology*, 47(6), 381–391.
Card, S. K., English, W. K., & Burr, B. J. (1978). Evaluation of mouse, rate-controlled isometric
joystick, step keys, and text keys for text selection on a CRT. *Ergonomics*, 21(8), 601–613.
MacKenzie, I. S. (1992). Fitts' law as a research and design tool in human-computer interaction.
*Human-Computer Interaction*, 7(1), 91–139. W3C (2023). WCAG 2.2, success criteria 2.5.5 and 2.5.8.
Apple Human Interface Guidelines and Material Design for the 44 pt and 48 dp sizes.

**Evidence.** Empirical. Distance and size are two terms of one model, not two separate laws.

## 3. Jakob's Law

**Finding.** Nielsen observed that people form their expectations of a site from all the other
sites they use, which is where they spend most of their time, so conventions shared across the
web carry over and departures from them cost effort.

**Rule.** Default to established patterns: a logo at top left that goes home, navigation along the
top or the left side, standard form controls, recognised icons for common actions, and the
platform's usual order of buttons in dialogs. A new interaction pattern needs a written reason
that names the benefit to the user. When replacing a familiar pattern, offer a transition (the
old view, a hint, an opt-out) for a while.

**Check.** For each control, identify which established pattern it uses. If it follows none, find the
recorded reason.

**Sources.** Nielsen, J. (2000, 23 July). End of Web Design. *Alertbox*, Nielsen Norman Group.
Nielsen, J. (1994). Enhancing the explanatory power of usability heuristics. *Proceedings of CHI
'94*, 152–158 (heuristic 4, consistency and standards).

**Evidence.** Observational. It is a practitioner generalisation, consistent with research on
mental models and transfer of training, not an experimental law.

## 4. Law of Proximity

**Finding.** Among the Gestalt grouping factors Wertheimer described, nearness is one of the
strongest: elements close together are seen as belonging together. Later psychophysics measured
how grouping strength falls off with distance.

**Rule.** The space between groups is at least twice the space inside a group. A label sits closer
to its own field than to any other field. Do not use equal spacing everywhere; it removes the
grouping signal.

**Check.** Blur the screenshot (or narrow your eyes at it). The clusters you see must be the clusters the design
intends.

**Sources.** Wertheimer, M. (1923). Untersuchungen zur Lehre von der Gestalt II. *Psychologische
Forschung*, 4, 301–350. Koffka, K. (1935). *Principles of Gestalt Psychology*. Kubovy, M., &
Wagemans, J. (1995). Grouping by proximity and multistability in dot lattices. *Psychological
Science*, 6(4), 225–234. Wagemans, J., et al. (2012). A century of Gestalt psychology in visual
perception I. *Psychological Bulletin*, 138(6), 1172–1217.

**Evidence.** Empirical.

## 5. Miller's Law

**Finding.** Miller reviewed absolute-judgement and immediate-memory studies and noted that
capacity hovers around seven items, but that people beat the limit by recoding items into larger
chunks. Later work puts working-memory capacity nearer four chunks when rehearsal and chunking
are controlled.

**Rule.** Present information in labelled groups of three to five items. Any list longer than
about seven gets grouping, search, sorting or filtering. Never make the user hold information
from one screen in mind to use it on the next; carry it forward.

**Check.** Look for flat lists over seven items and for steps that need recall of an earlier
value.

**Sources.** Miller, G. A. (1956). The magical number seven, plus or minus two: Some limits on our
capacity for processing information. *Psychological Review*, 63(2), 81–97. Cowan, N. (2001). The
magical number 4 in short-term memory. *Behavioral and Brain Sciences*, 24(1), 87–114.

**Evidence.** Empirical for memory span. "Seven" is a capacity estimate, not a rule for menu
length; menus are seen, not memorised. The rule uses it as a grouping trigger only.

## 6. Doherty Threshold (response time)

**Finding.** An IBM study by Doherty and Thadani reported that transaction productivity rose
sharply when system response time fell below about 400 ms. Earlier and later human-factors work
set the familiar limits: about 0.1 s for a response to feel instantaneous, about 1 s for the flow
of thought to stay unbroken, and about 10 s before attention is lost.

**Rule.** Every input produces a visible response within 100 ms (pressed state, caret, optimistic
update). Routine operations finish within 1 s. Anything slower shows progress, and anything longer
than about 10 s shows determinate progress with a way to cancel or continue in the background. Use
optimistic updates and skeleton layouts for network-bound work.

**Check.** Throttle the network and CPU, then time feedback and completion for each main action.

**Sources.** Doherty, W. J., & Thadani, A. J. (1982). *The economic value of rapid response time*
(IBM report GE20-0752-0). Miller, R. B. (1968). Response time in man-computer conversational
transactions. *AFIPS Fall Joint Computer Conference*, 33, 267–277. Card, S. K., Robertson, G. G.,
& Mackinlay, J. D. (1991). The information visualizer. *Proceedings of CHI '91*, 181–188.

**Evidence.** Observational. The 1982 report is industry measurement, not peer-reviewed research.
The 0.1 / 1 / 10 s limits are well-established guidance rather than a single experiment.

## 7. Von Restorff Effect (isolation effect)

**Finding.** In list-learning experiments, an item that differs from a homogeneous list on some
dimension is recalled better than the same item in a uniform list. Later analysis showed the
effect depends on contrast with the surrounding items, not on the oddity itself.

**Rule.** Each screen has exactly one visually dominant action. It differs in shape, size, weight
or position as well as colour, so it still stands out in greyscale and for colour-blind users
(WCAG 1.4.1). Emphasis is scarce: if several things are emphasised, none is.

**Check.** View the screen in greyscale. One action should still dominate.

**Sources.** von Restorff, H. (1933). Über die Wirkung von Bereichsbildungen im Spurenfeld.
*Psychologische Forschung*, 18, 299–342. Hunt, R. R. (1995). The subtlety of distinctiveness: What
von Restorff really did. *Psychonomic Bulletin & Review*, 2(1), 105–112. W3C, WCAG 2.2 success
criterion 1.4.1 (Use of Color).

**Evidence.** Empirical for memory. Its use for drawing attention to a call to action leans on
the related pop-out findings in visual search.

## 8. Serial Position Effect

**Finding.** Ebbinghaus noted that position in a list affects learning. Murdock's free-recall
curves showed the classic U shape: the first items (primacy) and the last items (recency) are
recalled best, and the middle worst. Glanzer and Cunitz linked recency to short-term memory and
primacy to longer-term storage.

**Rule.** In navigation bars, menus and summaries, the two ends of the sequence hold the items that matter most, and the middle holds the rest. In long scrolling content, lead with the key point.

**Check.** For each ordered set, name the two most important items and confirm they occupy the
ends.

**Sources.** Ebbinghaus, H. (1885). *Über das Gedächtnis*. Leipzig: Duncker & Humblot. Murdock,
B. B. (1962). The serial position effect of free recall. *Journal of Experimental Psychology*,
64(5), 482–488. Glanzer, M., & Cunitz, A. R. (1966). Two storage mechanisms in free recall.
*Journal of Verbal Learning and Verbal Behavior*, 5(4), 351–360.

**Evidence.** Empirical for recall of lists. Its application to menus, which are seen rather than
recalled, is a reasonable extension rather than a tested result.

## 9. Peak-End Rule

**Finding.** When people rate a past experience as a whole, the rating tracks the most intense
moment and the final moment, while total duration has little weight (duration neglect). In the
cold-water study, participants preferred a longer trial that ended less painfully.

**Rule.** Design the worst moments and the last moment of each flow on purpose. Every flow ends in
a deliberate success state that confirms what happened and offers a next step, never a blank page
or a toast that disappears. Errors at the emotional low point (payment failure, data loss risk)
get the most careful copy and recovery.

**Check.** Run every flow through to completion. Find the hardest moment and the final screen and judge both
on their own.

**Sources.** Fredrickson, B. L., & Kahneman, D. (1993). Duration neglect in retrospective
evaluations of affective episodes. *Journal of Personality and Social Psychology*, 65(1), 45–55.
Kahneman, D., Fredrickson, B. L., Schreiber, C. A., & Redelmeier, D. A. (1993). When more pain is
preferred to less: Adding a better end. *Psychological Science*, 4(6), 401–405. Redelmeier, D. A.,
& Kahneman, D. (1996). Patients' memories of painful medical treatments. *Pain*, 66(1), 3–8.

**Evidence.** Empirical for retrospective evaluation of episodes. Effect sizes vary with the kind
of experience; treat it as a priority signal, not permission to neglect the middle.

## 10. Zeigarnik Effect

**Finding.** In Zeigarnik's experiments, participants who were interrupted during tasks later
recalled the unfinished tasks more often than the finished ones. Ovsiankina, working in the same
laboratory, found that people spontaneously resume interrupted tasks. Replications of the memory
advantage are mixed; the resumption tendency is more robust.

**Rule.** Multi-step tasks show how many steps there are, which step the user is on and what is
left. Unfinished work is saved and visibly resumable. Do not exploit open loops to manufacture
compulsion (fake badges, artificial incompleteness).

**Check.** Interrupt a multi-step task midway, leave and return. Confirm that the position and the
remaining work are shown and that nothing was lost.

**Sources.** Zeigarnik, B. (1927). Das Behalten erledigter und unerledigter Handlungen.
*Psychologische Forschung*, 9, 1–85. Ovsiankina, M. (1928). Die Wiederaufnahme unterbrochener
Handlungen. *Psychologische Forschung*, 11, 302–379.

**Evidence.** Empirical, with mixed replication for the memory effect.

## 11. Law of Prägnanz (good figure)

**Finding.** The Gestalt school proposed that perception settles on the most regular, simple and
stable organisation the input allows. It is the umbrella principle behind the specific grouping
factors, and is the hardest of them to measure directly.

**Rule.** Prefer plain, aligned layouts on a consistent grid, with little ornament. A layout that
needs explanation to be understood should be simplified. Avoid shapes and arrangements that admit
two readings.

**Check.** Show the screen to someone for one second. They should be able to name its main regions
and its main action.

**Sources.** Wertheimer, M. (1923), as in entry 4. Koffka, K. (1935). *Principles of Gestalt
Psychology*. Wagemans, J., et al. (2012). A century of Gestalt psychology in visual perception II.
*Psychological Bulletin*, 138(6), 1218–1252.

**Evidence.** Empirical as a family of perceptual findings. As a single law it is descriptive and
partly contested; use it as a design aim.

## 12. Law of Similarity

**Finding.** Elements that share colour, shape, size or orientation read as belonging together, whether or not they are adjacent. Wertheimer listed similarity alongside proximity.

**Rule.** One function, one appearance, everywhere in the product. Two elements look alike only if
they behave alike, and elements that behave alike look alike. Links, buttons, inputs and status
colours keep one visual treatment each.

**Check.** Find pairs that look the same but do different things, and pairs that do the same thing
but look different.

**Sources.** Wertheimer, M. (1923), as in entry 4. Wagemans, J., et al. (2012), Part I, as in
entry 4.

**Evidence.** Empirical.

## 13. Uniform Connectedness and Common Region

**Finding.** Palmer and Rock showed that regions of uniform colour or texture, and elements joined
by lines, are grouped more strongly than proximity or similarity alone would predict. Palmer also
showed that elements inside a shared bounded region are grouped (common region).

**Rule.** Fields and controls that belong together sit inside one card, outline or tinted panel. A sequence uses a
connecting line or rail. A container holds only items that belong together; one unrelated item
inside a card breaks the group.

**Check.** For each card, panel or bordered region, confirm every item inside belongs to the same
group, and that no member of the group sits outside.

**Sources.** Palmer, S., & Rock, I. (1994). Rethinking perceptual organization: The role of
uniform connectedness. *Psychonomic Bulletin & Review*, 1(1), 29–55. Palmer, S. E. (1992). Common
region: A new principle of perceptual grouping. *Cognitive Psychology*, 24(3), 436–447.

**Evidence.** Empirical.

## 14. Tesler's Law (conservation of complexity)

**Finding.** Larry Tesler, working on interfaces at Xerox PARC and Apple, argued that every
application carries a core of complexity that cannot be removed, only moved, and that it is better
for the engineers to carry it than the users.

**Rule.** The system takes on the complexity: sensible defaults, values inferred from context or
earlier answers, formats handled automatically, advanced settings available but not required.
Removing an option the task needs does not reduce complexity; it pushes it onto the user.

**Check.** List every value the user must supply. For each, ask whether the system could default,
infer or remember it.

**Sources.** Saffer, D. (2009). *Designing for Interaction* (2nd ed.). New Riders, including an
interview with Larry Tesler on the principle. Tesler described it from his work in the mid-1980s.

**Evidence.** Heuristic. It is a designer's maxim with no formal measurement of "complexity".

## 15. Postel's Law (robustness principle)

**Finding.** In the early Internet protocol specifications, Jon Postel set the rule that an
implementation should be strict in what it sends and tolerant in what it receives. RFC 1122
restated and extended it. RFC 9413 later documented the costs of unlimited tolerance in protocols.

**Rule.** Accept the reasonable variants of an input (spaces and dashes in a phone number, mixed
case, pasted whitespace, several date formats) and normalise them. Validate inline, close to the
field. Each error message names the problem and the fix. Destructive actions can be undone or
require confirmation. Be strict in what the interface produces: stored values, exports and
messages use one canonical form.

**Check.** Try the obvious variants of each input. Trigger every error and read whether it says
how to recover. Attempt each destructive action and look for undo or confirmation.

**Sources.** Postel, J. (Ed.) (1980). *DoD Standard Internet Protocol*. RFC 760, section 3.2.
Braden, R. (Ed.) (1989). *Requirements for Internet Hosts: Communication Layers*. RFC 1122,
section 1.2.2. Thomson, M., & Schinazi, D. (2023). *Maintaining Robust Protocols*. RFC 9413.

**Evidence.** Heuristic. It is an engineering principle for protocols; its use in interface design
is an analogy. RFC 9413 is a reminder that tolerance should be bounded and explicit.

## 16. Parkinson's Law

**Finding.** Parkinson's essay, a satire of bureaucratic growth, opened with the quip that work stretches to occupy whatever time has been allotted to it. Bryan and Locke later found that people given more
time adjusted their pace and goals accordingly.

**Rule.** Use the fewest steps and fields the outcome needs. Autofill, remembered values and
sensible defaults let the user finish sooner than they expect. Do not add steps or waiting that
do not change the result.

**Check.** On the main path, remove each field or step in turn. If the outcome is unchanged, it
should go.

**Sources.** Parkinson, C. N. (1955, 19 November). Parkinson's Law. *The Economist*. Bryan, J. F.,
& Locke, E. A. (1967). Parkinson's law as a goal-setting phenomenon. *Organizational Behavior and
Human Performance*, 2(3), 258–275.

**Evidence.** Heuristic. The original is satire; the goal-setting evidence is indirect.

## 17. Occam's Razor (parsimony)

**Finding.** The scholastic principle attributed to William of Ockham: do not multiply entities
beyond necessity. Among explanations that account for the facts equally well, prefer the one
with fewer assumptions.

**Rule.** Every element on a screen serves the current task, or it is removed or moved. Between
two designs that perform equally well, ship the simpler one. Parsimony applies to presentation;
it does not justify removing error handling, labels or required options.

**Check.** Point at each visible element and name the task it serves.

**Sources.** William of Ockham (14th century), as transmitted in later scholastic writing. Baker,
A. Simplicity. In *The Stanford Encyclopedia of Philosophy*.

**Evidence.** Heuristic. It is a principle of reasoning, not a finding about users.

## 18. Pareto Principle

**Finding.** Pareto documented a highly unequal distribution of land and income in Italy. Juran
generalised the pattern as "the vital few and the trivial many" for quality problems, and named it
after Pareto. In software, a small share of features or defects often accounts for most of the use
or failures, but the exact proportion varies.

**Rule.** The most-used features get the most prominent places and the shortest paths. The rest
remain reachable through menus or settings. Base "most used" on data when you have it, and label
it as an assumption when you do not.

**Check.** Compare the first screen with usage data or a written guess. Each prominent item should
be among the most-used.

**Sources.** Pareto, V. (1896–1897). *Cours d'économie politique*. Lausanne: F. Rouge. Juran, J. M.
(1951). *Quality Control Handbook*. McGraw-Hill.

**Evidence.** Heuristic. Skewed distributions are common, but "80/20" is a mnemonic, not a ratio.

## 19. Goal-Gradient Effect

**Finding.** Hull proposed that animals work harder as they near a reward, and found that rats ran
faster in the later segments of a maze. Kivetz, Urminsky and Zheng showed the same pattern in
people: coffee-card customers bought more often as they neared a free drink. Nunes and Drèze
showed that a card with two stamps already given (an endowed head start) was completed more often
than an equivalent card without them.

**Rule.** Show progress toward the goal and what remains. A head start is allowed only when it
reflects real work already done (an imported profile, a completed step). Progress never jumps,
stalls or resets for effect, and is never invented.

**Check.** Compare the displayed progress with the actual completed work at each step.

**Sources.** Hull, C. L. (1932). The goal-gradient hypothesis and maze learning. *Psychological
Review*, 39(1), 25–43. Kivetz, R., Urminsky, O., & Zheng, Y. (2006). The goal-gradient hypothesis
resurrected. *Journal of Marketing Research*, 43(1), 39–58. Nunes, J. C., & Drèze, X. (2006). The
endowed progress effect. *Journal of Consumer Research*, 32(4), 504–512.

**Evidence.** Empirical.

## 20. Chunking

**Finding.** Miller described recoding as the way people exceed the span of immediate memory.
Chase and Simon found that chess masters remember board positions as familiar patterns, which
explains their memory advantage for real positions and its absence for random ones.

**Rule.** Break long identifiers, numbers and codes into short groups (card numbers in fours,
phone numbers by their national pattern, one-time codes in groups of three or four). Break long
content into sections with headings. Group with spacing, not with characters the user must type.

**Check.** Find any unbroken string longer than about seven characters that people must read or
copy, and any long text block without headings.

**Sources.** Miller, G. A. (1956), as in entry 5. Chase, W. G., & Simon, H. A. (1973). Perception
in chess. *Cognitive Psychology*, 4(1), 55–81. Gobet, F., et al. (2001). Chunking mechanisms in
human learning. *Trends in Cognitive Sciences*, 5(6), 236–243.

**Evidence.** Empirical.

---

## Tensions

Some of these rules pull in opposite directions. Settle a conflict with the precedence below,
not by choosing whichever rule supports the design already preferred.

| Conflict | Precedence and how to apply it |
|---|---|
| Hick (show fewer options) vs Tesler (required complexity cannot be removed) | Tesler limits Hick. Cut visible choices through defaults, grouping and later steps; never drop an option the task needs. |
| Von Restorff (one element stands out) vs Similarity (alike things look alike) | Similarity limits Von Restorff. Exactly one element breaks the pattern. A second or third emphasis cancels the first. |
| Jakob (follow convention) vs novelty or brand distinctiveness | Convention by default. Departing from it requires a written benefit to users and a period in which the old pattern stays available. |
| Occam (fewer parts) vs Postel (lenient input, recoverable errors) | Postel decides how input is accepted and errors are recovered. Occam applies only to what is displayed. |
| Goal-Gradient (completion should feel near) vs honesty | Honesty wins. A head start must reflect work actually done. |
| Doherty (respond fast) vs a deliberate pause that signals effort | Feedback is always immediate. An intentional wait is tolerable just before an outcome the user cares about (a generated report, a fraud screen), and it must display its progress. |
| Miller (group into chunks) vs Hick (fewer options) vs Pareto (the frequent few) | Pareto selects which items appear, Hick caps their number, and Miller sets their grouping. |
| Any empirical rule vs a heuristic | The empirical rule wins. Parkinson, Occam, Pareto, Tesler and Postel are heuristics; Jakob and Doherty are observational. |

## Related reading

- Nielsen, J. (1994). Enhancing the explanatory power of usability heuristics. *CHI '94*. The ten
  usability heuristics overlap with several entries here.
- Card, S. K., Moran, T. P., & Newell, A. (1983). *The Psychology of Human-Computer Interaction*.
  Lawrence Erlbaum. The model human processor and the quantitative basis for entries 1, 2 and 6.
- Johnson, J. (2020). *Designing with the Mind in Mind* (3rd ed.). Morgan Kaufmann. Perception and
  memory research written for designers.
- Jon Yablonski's Laws of UX website and book collect many of these principles. This skill was
  written independently from the primary sources above and does not reproduce that material.
- For hands-on design execution (layout, tokens, motion, critique), use the Hermes `impeccable`
  skill where it is installed.

## Using this document

- **Generating UI.** Put `assets/ux-principles.md` in the instruction file the agent reads
  (`AGENTS.md`, `.hermes.md`, `CLAUDE.md` or similar). The block names no tool, so it works
  unchanged across harnesses.
- **Reviewing UI.** Paste `assets/review-checklist.md` into the PR description or design-review notes. Each
  answer points to a screen or component, or states why the item does not apply.
- **Disagreements.** Consult the tensions table; if it is silent, the better-evidenced rule
  prevails (empirical, then observational, then heuristic).
