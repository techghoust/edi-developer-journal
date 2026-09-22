# EDI DEVELOPER JOURNAL: USER GUIDE

this guide explains the current behavior of version `0.2.0`

---

## INSTALLATION

download the packages from the [latest GitHub release](https://github.com/techghoust/edi-developer-journal/releases/latest)

### Windows

download the file ending in `_x64-setup.exe`, run it and open `EDI Developer Journal` from the Start menu

### Linux

the Linux release targets x86_64 systems and provides two packages:

- `.AppImage` runs without installation;
- `.deb` installs on Debian, Ubuntu and compatible distributions

to run the AppImage:

```bash
chmod +x EDI*.AppImage
./EDI*.AppImage
```

to install the Debian package from its download directory:

```bash
sudo apt install ./EDI*.deb
```

the Linux application requires WebKitGTK 4.1. Git must be installed for repository integration

on first launch the project list is empty. release packages do not include example projects or another user's journal data

---

## ADD A PROJECT

open the application and use `New Project`

1. enter the name that should appear in EDI;
2. select the repository folder with `browse`;
3. choose `create project`

use `open existing` when the folder should be registered with its current folder name. enable `allow folder without Git` only when the selected folder is not a Git repository

adding a project does not copy or modify its source files

---

## OPEN THE WORKSPACE

projects appear under `Recent Projects`. selecting one opens the main project window and the connected memory windows

the main window shows:

- repository path and Git state;
- notes and recent commits;
- checkpoints;
- research;
- experiments;
- EDI context

use `>` beside a note to open the complete entry

---

## NOTES

use notes for implementation details, discoveries, explanations and unfinished thoughts

a note can contain:

- a title;
- Markdown text;
- tags;
- related commit hashes

open an existing note to edit or delete it

---

## CHECKPOINTS

create a checkpoint before pausing the project or changing direction

a checkpoint can store:

- current work;
- working parts;
- broken or unfinished parts;
- the current question;
- decisions made;
- rejected alternatives;
- open questions;
- the next step

`Resume From Here` uses checkpoints together with recent project memory

---

## DECISIONS

a decision stores what was chosen and why

available states:

- active;
- experimental;
- superseded;
- rejected

a decision can reference a parent decision, replacement decision, checkpoint, commits, files, notes, research and assumptions

temporary decisions can include a revisit condition or date. they remain visible as decision debt until reviewed or dismissed

---

## ASSUMPTIONS

an assumption stores something currently treated as true

available states:

- active;
- questioned;
- invalidated

when a decision or experiment depends on an invalidated assumption, EDI can expose the conflict

---

## RESEARCH AND MEDIA

research items support:

- note;
- link;
- PDF;
- image;
- video

use `browse` for a local file. EDI copies the selected file into managed storage, so deleting or moving the original does not remove the saved copy

select an image preview to open the larger viewer

remote media depends on the original URL and an internet connection

---

## EXPERIMENTS

an experiment can store:

- title;
- hypothesis;
- what was tested;
- method;
- result;
- conclusion;
- status;
- date;
- related evidence and assumptions;
- resulting decision

failed, inconclusive and abandoned experiments remain in failure memory

---

## GIT

use `refresh git` to update repository information immediately

EDI reads:

- HEAD;
- remote URL;
- recent commits;
- working tree state;
- changed and untracked file counts

EDI does not write to the repository

if the repository folder moves, EDI tries to identify it by Git history. automatic relocation happens only when one safe match is found. otherwise use `relocate`

---

## X-RAY

X-Ray analyzes npm projects through `package.json` and `package-lock.json`

select a dependency to inspect:

- direct or transitive status;
- version;
- parents and children;
- source usage;
- possible removal impact;
- related project memory

`simulate removal` does not change the repository. it produces an informational report only

use `save relationships` to connect a dependency with notes, checkpoints, decisions, research, experiments or assumptions

---

## WHY?

use `Why?` to inspect the evidence behind a memory item. available context depends on the item and can include commits, files, notes, research, decisions, experiments and assumptions

---

## RESUME FROM HERE

use `Resume From Here` after returning to a project

the window combines:

- latest checkpoint;
- open decisions;
- recent memory;
- active experiments;
- Git activity;
- suggested next step

---

## SETTINGS

### project name

changes the name displayed inside EDI. it does not rename the repository folder

### project path / repository

updates the registered folder manually. use it only when automatic relocation did not find the moved repository or when the project should point to another folder

### export / import

`export JSON` saves project memory to a JSON file

`import JSON` merges an EDI export into the current project. existing records are preserved and repeated records are skipped

JSON files do not contain copies of local media

### Git integration

shows the current cached Git state and refreshes it on request

### delete project

removes the project and its journal memory from EDI. repository files remain on disk

---

## COMPLETE BACKUP

close EDI and copy the application data directory for the current system

Windows:

```text
%APPDATA%\EDI Developer Journal
```

Linux:

```text
~/.config/EDI Developer Journal
```

the directory contains the SQLite database and managed attachments

keep the backup private when the journal contains sensitive project information

