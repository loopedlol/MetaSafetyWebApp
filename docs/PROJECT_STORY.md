# Safety Lens / Project story

[← Project overview](../README.md) · [Architecture](typescript-architecture.md) · [Capture boundary](native-dat-capture.md)

The original design reflections, retained in Colin's voice. These describe a prototype; current implementation boundaries and setup are in the project overview.

## How I originally imagined it

At first, I imagined the flow being something like this:

```text
Worker sees a hazard
        ↓
Glasses take a photo
        ↓
AI analyzes it
        ↓
Hazard and suggested action appear
        ↓
Record is added to the safety report
```

That sounded simple, but building the prototype forced me to separate what I *wanted* the device to do from what its web environment could actually do.

The glasses web app itself does not simply get unrestricted camera access. Because of that, I changed the design instead of faking the capability.

The current project separates three things:

```text
Normal browser dashboard
        ↕
Shared session / server
        ↕
Glasses web interface
        ↕
Optional authenticated Android companion for real capture
```

The browser glasses preview still contains clearly labeled mock capture behavior so I can test the workflow without physical hardware.

## What I learned

### 1. Hardware limitations can completely change a software design

One of the biggest lessons from this project was that designing for smart glasses is not the same as making a smaller phone app.

The display is small, input is limited, and some capabilities I initially expected were not available directly to the web app. I had to redesign the workflow around what the device could reliably provide rather than build around assumptions.

This made me think much more carefully about separating **device capabilities** from the rest of the application. The shared app now receives simple actions such as move, select, back, controlled, or action-required instead of depending directly on one specific device.

### 2. A wearable interface should not try to do everything

My first instinct was to put as much functionality as possible on the glasses. After working with the 600 × 600 interface, I realized that this usually makes the experience worse.

The normal dashboard is better for tasks such as entering detailed corrective actions, reviewing records, managing pairing, and opening reports. The glasses are more useful for short actions that need to happen while somebody is moving through a worksite.

That division became an important design decision rather than just a screen-size problem.

### 3. Safety software needs more confirmation than a normal app

For a normal consumer app, fewer clicks is often better. I found that this idea does not always carry over to a safety workflow.

For example, the program separates:

- worker attendance from worker acknowledgment;
- identifying a hazard from confirming its status;
- saving a draft from finalizing a record;
- an AI suggestion from a human-approved safety record.

It would have been easier to automatically fill in some of these steps, but doing that could make the record say something happened when it did not.

### 4. I had to be careful not to make the AI look more capable than it is

The current AI mode is a **deterministic mock** used to test the workflow. It does not inspect image pixels and it is not a real automated safety inspector.

I kept it because it lets me test questions such as:

- Where should an AI suggestion appear?
- How should it be labeled?
- Can a user accept, edit, or reject it?
- What information should be stored afterward?

That taught me that integrating AI is not only about calling a model. The interface around the model and the way uncertainty is communicated matter too.

### 5. Offline behavior becomes difficult once the same record exists in several places

I wanted the app to remain usable when the network was unreliable, which led me to add local drafts, IndexedDB storage, queued changes, and synchronization.

The difficult part was not simply saving something offline. It was deciding what should happen when a local version and a server version both change.

This made me understand why synchronization and state management are major parts of real applications even when the visible feature seems simple.

### 6. Security became part of the architecture, not an extra feature

Once the project started storing users, worksite records, and photo evidence, I had to think about who should be able to access each item.

The backend therefore handles ownership checks, private uploads, restricted glasses sessions, expiring pairing codes, and audit events. The project also keeps uploaded evidence behind authenticated routes instead of exposing the files publicly.

I did not start this project mainly to learn backend security, but it ended up becoming a large part of what I learned.


## Final reflection

This started as an idea about using smart glasses to make workplace-safety information easier to access. The most useful part of building it was learning how many other problems appear once that idea becomes an actual system: limited hardware inputs, small-screen UI design, offline data, authentication, privacy, evidence storage, synchronization, and deciding when automation should *not* make a decision for the user.

The project is not a finished safety product, but it gave me a much better understanding of how a hardware idea turns into a real software architecture—and how the constraints of the device can be just as important as the original idea.
