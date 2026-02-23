# Book Club Website

A full-featured book club management app with:
- Book search autocomplete (Open Library API — free, no key needed)
- Running book list with who added each book
- Voting system with hidden results until admin reveals them
- SQLite database (no setup required, file created automatically)

---

## Setup

### 1. Install Node.js

Download and install from: https://nodejs.org (choose the LTS version)

### 2. Install dependencies

Open a terminal in this folder and run:

```
npm install
```

### 3. Start the server

```
npm start
```

Then open your browser to: **http://localhost:3000**

---

## Admin Password

The default admin password is: **bookclub123**

To change it, set an environment variable before starting:

**Windows (Command Prompt):**
```
set ADMIN_PASSWORD=yourpassword && npm start
```

**Windows (PowerShell):**
```
$env:ADMIN_PASSWORD="yourpassword"; npm start
```

**Mac/Linux:**
```
ADMIN_PASSWORD=yourpassword npm start
```

---

## How It Works

### For Members
1. Enter your name when you first visit (saved in your browser)
2. **Add Book tab** — search for a book and select from the autocomplete list, or type manually
3. **Book List tab** — see all books, who added them, and their status
4. You can remove your own books from voting using the "Remove from Voting" button
5. **Vote tab** — when a session is open, select 2 books and submit your vote

### For the Admin
1. Click "Admin Login" in the top-right nav bar
2. Enter the admin password
3. **Admin tab** — start a new voting session, view live results, and close voting to reveal results to everyone
4. Mark books as "Selected" (the book the club will read) from the Book List tab

### Notes
- Results are **hidden from members** until you close the voting session
- Each member can only vote once per session (tracked by name)
- The database is stored as `bookclub.db` in this folder
