# Artema Portal: open questions for the real README

Answer in your own words, in any order. Short is fine, and "not sure yet" is a real answer.
When a question is answered, write the answer under it and change its status to `answered`. Anything still `open` is
something the README cannot say yet.

Starting point (from the current README): *an app to replace OneDrive and Monday, originally made just to transfer files
locally across the Artema shop from the office to the CNC.*

---

## 1. Goal and scope

**1.1 In one or two sentences, what is Artema Portal for?** (status: open)
Answer:

**1.2 What is the main thing it must do well, the one that decides whether people use it?** (status: open)
Answer:

**1.3 What does "replace OneDrive" mean here? Which OneDrive jobs matter (sharing, backup, access from home, versions)?** (status: open)
Answer:

**1.4 What does "replace Monday" mean here? Job tracking, task assignment, schedules, notes, status boards?** (status: open)
Answer:

**1.5 What is out of scope, at least for now? What should it never try to be?** (status: open)
Answer:

**1.6 How will we know it is working? What would make you say "this was worth building"?** (status: open)
Answer:

## 2. People and roles

**2.1 Who uses it day to day (owner, office, estimators, CNC operators, installers, shipping)? Roughly how many people and machines?** (status: open)
Answer:

**2.2 What should a *general* (shop floor) computer be able to do, and not do?** (status: open)
Answer:

**2.3 What should an *admin* be able to do that general cannot?** (status: open)
Answer:

**2.4 What is *dev* for, and who gets it?** (status: open)
Answer:

**2.5 Do roles stay per computer (a shared shop PC is always "general"), or do people eventually need their own logins?** (status: open)
Answer:

**2.6 Does anyone need to be locked out of certain folders or jobs (pricing, customer info, drawings)?** (status: open)
Answer:

## 3. Files and the CNC workflow

**3.1 Walk through a real job from start to finish: who creates files, who sends them, who picks them up at the CNC?** (status: open)
Answer:

**3.2 Which file types matter (DXF, PDF, CAD, G-code, photos)? Any very large ones?** (status: open)
Answer:

**3.3 Which CNC machines and controllers are involved, and how do they read files today (USB, network share, their own software)?** (status: open)
Answer:

**3.4 Do files need versions or history ("go back to yesterday's drawing")?** (status: open)
Answer:

**3.5 Should the CNC side see only what is ready to cut, or everything?** (status: open)
Answer:

**3.6 How should deletions work? Is a trash that keeps deleted files for a while enough?** (status: open)
Answer:

## 4. Jobs and tracking (the "Monday" part)

**4.1 What does the shop track per job today, and where (Monday, paper, memory)?** (status: open)
Answer:

**4.2 What statuses does a job go through (quoted, approved, drawn, cut, assembled, shipped)?** (status: open)
Answer:

**4.3 Should files hang off a job (a job folder with a status), or stay as plain folders for now?** (status: open)
Answer:

**4.4 Notifications: who should be told what, and when? Pop-up, sound, email?** (status: open)
Answer:

## 5. Network, access and safety

**5.1 Does everything stay inside the shop network, or do people need access from home or a job site?** (status: open)
Answer:

**5.2 What happens if the main computer is off or broken? How long can the shop live without it?** (status: open)
Answer:

**5.3 Backups: is a copy of the shared files kept somewhere else? How much loss is acceptable?** (status: open)
Answer:

**5.4 How sensitive are the files (customer details, pricing)? Is there anything that must never leave the building?** (status: open)
Answer:

**5.5 Which computers are in play (Windows only? any Macs, tablets, phones)?** (status: open)
Answer:

## 6. Design and feel

**6.1 What should it feel like to use? Simple enough for someone who hates computers, or powerful for the office?** (status: open)
Answer:

**6.2 Anything you have seen (an app, a screen) that is the right level of simple?** (status: open)
Answer:

**6.3 Branding: Artema logo, colours, name wording, anything that must or must not appear?** (status: open)
Answer:

**6.4 How should updates reach the computers? Fully automatic, or someone approves each one?** (status: open)
Answer:

## 7. Plan and priorities

**7.1 What is the very next thing that must work in the shop (the first real use, after the demo for Ben)?** (status: open)
Answer:

**7.2 What are the next three things after that, in order?** (status: open)
Answer:

**7.3 Is there a date or event that matters (a rollout, a busy season)?** (status: open)
Answer:

**7.4 Who decides what gets built, and who tests it before the shop floor sees it?** (status: open)
Answer:

**7.5 Anything the README must warn people about (known limits, things not built yet)?** (status: open)
Answer:

---

## What the README still needs from the code side (no answer needed from you)

- A plain description of the two builds (server and client) and how to install each.
- How roles work (general, admin, dev) and how to assign one. There is no screen for this yet, only the API.
- How to build and test (`npm run dist`, `npm test`).
- The old Python prototype: keep, archive, or remove. The README should say which.
