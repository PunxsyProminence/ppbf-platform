# VISUAL NOTES

**Started 2026-09-24. Empty on purpose.**

Jason, 2026-09-24: *"let's scrap all the visual rules ... let's start the rules
from scratch when we find somthing that we want to turn into a rule we will."*

The previous rule set is archived under `archive/visual-rules-2026-09-24/` —
21 guard files, roughly 200 assertions. It was not deleted because it was
wrong; it was retired because it enforced a visual language the club is
replacing, and a rule defending an abandoned decision is not protection. The
clearest proof: it forbade "generic grey-brown brick + caged industrial lamps"
and "a pure leather-and-brass set", while the thing actually built on top of
it was a brass-and-parchment board standing on a brick-and-caged-lamp plate.

---

## How a rule gets into this file

Only one way. **Something bites, and we write down what bit us.**

Not "this would be good practice". Not "other apps do this". Something has to
go visibly wrong first — on a screen, in the gym, in front of a coach or a kid
— and then the note records what happened and what we do instead.

A note here has three parts and no more:

    WHAT WENT WRONG   the actual failure, concretely, with the date
    WHY IT MATTERED   who was affected and how
    WHAT WE DO NOW    the smallest thing that prevents a repeat

If a note cannot name a real failure, it does not belong here yet.

---

## Things already learned the hard way

Kept as a short memory rather than as enforcement, so that if we meet them
again we recognise them instead of paying twice. None of these is currently
enforced by anything.

- **Text has to be readable on the ground it sits on.** A sign-in board once
  rendered dark-on-dark across heading, body, labels and plaque while 536
  other tests passed. Nothing caught it, because nobody is looking at every
  screen every day.
- **A control that takes focus has to show it.** Focus indicators here live in
  `box-shadow`, so a later rule that sets `box-shadow` on the same control
  deletes the indicator outright and silently.
- **A colour that means one thing should not also mean another.** If a red
  means "a doctor said no", it cannot also mean "the network is down".
- **A number nobody can read from arm's length is decoration.** This is a gym.
  People look up at a screen mid-round, from across a room, sweating.
- **An image that is broken in a way a header check cannot see still looks
  fine to every automated check.** Three plate deliveries failed invisibly
  before anyone opened the bytes.

---

## What the interface is trying to do

Jason, 2026-09-24, on what replaces columns:

> *"use gauges graphs or a visual effect where it makes sense, the page becomes
> less cluttered and inference can happen immediately when the user looks at
> it"*

> *"Make the gauges click able to open into the real data, the gauge will help
> identify quickly that a closer look is needed"*

> *"I dont what everything to be a boiler plate, places should feel like
> another room off the gym"*

So: **glance → the gauge flags → open → the real records.** Each surface is a
room in the same building, not a re-skin of one template.

Targets for this pass are the **wall screen** and a **tablet**. Phone is
deliberately out of scope for now.
