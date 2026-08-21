# PPBF Platform Data Seeding Guide

## Overview

This guide walks you through uploading your athlete, goal, and session (workout) data to the PPBF platform. The seed system supports **CSV and JSON** formats with automatic validation and error reporting.

---

## 🚀 Quick Start (5 minutes)

### 1. Prepare Your Data

You need **at least one** of these files:
- `athletes.csv` — Athlete roster
- `sessions.csv` — Workout/training sessions  
- `goals.csv` — Athlete goals

Place them in: `scripts/data/`

### 2. Create Config

```bash
cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts
```

Edit `scripts/seed-data.config.ts`:
```typescript
export default {
  organizationId: 'your-org-id',    // ← Change this
  dataDir: './scripts/data',
  files: {
    athletes: 'athletes.csv',
    sessions: 'sessions.csv',
    goals: 'goals.csv',
  },
  options: {
    dryRun: false,
  },
};
```

### 3. Test (Dry Run)

```bash
npm run seed:data:dry
```

Output:
```
📊 PPBF Data Seed Script
Organization: your-org-id
Dry Run: YES

Loading athletes from athletes.csv...
  ✓ Inserted: 5, Skipped: 0, Errors: 0

Loading sessions from sessions.csv...
  ✓ Inserted: 8, Skipped: 0, Errors: 0

Summary:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
athletes             | Inserted:      5 | Skipped:      0 | Errors:      0
sessions             | Inserted:      8 | Skipped:      0 | Errors:      0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total: Inserted 13 | Skipped 0 | Errors 0

✨ Dry run complete. No changes were made.
```

### 4. Deploy

Once satisfied with the dry run:

```bash
npm run seed:data
```

---

## 📋 Data Format Specifications

### Athletes Table

**CSV Example:**
```csv
athlete_id,full_name,dob,weight_class,gym_status,emergency_contact,active_flag,coach_id
ath-001,Alex Johnson,2008-03-15,middleweight,active,555-0101,true,coach-001
ath-002,Jordan Lee,2007-07-22,heavyweight,active,555-0102,true,coach-001
```

**Required Columns:**
| Column | Type | Format | Example | Notes |
|--------|------|--------|---------|-------|
| athlete_id | string | Unique ID | "ath-001" | Must be unique within org |
| full_name | string | Text | "Alex Johnson" | Athlete's full name |
| dob | date | YYYY-MM-DD | "2008-03-15" | Date of birth |
| weight_class | string | e.g., "middleweight" | "heavyweight" | Predefined categories |
| gym_status | string | e.g., "active" | "training" | active / training / inactive |
| emergency_contact | string | Phone/email | "555-0101" | Contact information |
| active_flag | boolean | true/false or 1/0 | "true" | Active in system |
| coach_id | string | Coach ID | "coach-001" | Must reference existing coach |

**JSON Equivalent:**
```json
[
  {
    "athlete_id": "ath-001",
    "full_name": "Alex Johnson",
    "dob": "2008-03-15",
    "weight_class": "middleweight",
    "gym_status": "active",
    "emergency_contact": "555-0101",
    "active_flag": true,
    "coach_id": "coach-001"
  }
]
```

---

### Sessions (Workouts) Table

**CSV Example:**
```csv
session_id,athlete_id,date,rpe,notes,completed_flag
sess-001,ath-001,2026-07-18,7,Good form on takedowns,true
sess-002,ath-001,2026-07-19,8,Worked on positioning,true
```

**Required Columns:**
| Column | Type | Format | Example | Notes |
|--------|------|--------|---------|-------|
| session_id | string | Unique ID | "sess-001" | Must be unique within org |
| athlete_id | string | Athlete ID | "ath-001" | Must reference existing athlete |
| date | date | YYYY-MM-DD | "2026-07-18" | Session date |
| rpe | number | 0-10 | "7" | Rate of perceived exertion |
| notes | string | Text | "Good form..." | Session notes |
| completed_flag | boolean | true/false or 1/0 | "true" | Was session completed |

**JSON Equivalent:**
```json
[
  {
    "session_id": "sess-001",
    "athlete_id": "ath-001",
    "date": "2026-07-18",
    "rpe": 7,
    "notes": "Good form on takedowns",
    "completed_flag": true
  }
]
```

---

### Goals Table

**CSV Example:**
```csv
goal_id,athlete_id,title,target_date,metric,status
goal-001,ath-001,Master Throw Technique,2026-12-31,technical_proficiency,active
goal-002,ath-002,Improve Conditioning,2026-09-30,vo2_max,in_progress
```

**Required Columns:**
| Column | Type | Format | Example | Notes |
|--------|------|--------|---------|-------|
| goal_id | string | Unique ID | "goal-001" | Must be unique within org |
| athlete_id | string | Athlete ID | "ath-001" | Must reference existing athlete |
| title | string | Text | "Master Throw..." | Goal title |
| target_date | date | YYYY-MM-DD | "2026-12-31" | Target completion date |
| metric | string | Metric name | "technical_proficiency" | What's being measured |
| status | string | Status enum | "active" | active / in_progress / pending / completed |

**JSON Equivalent:**
```json
[
  {
    "goal_id": "goal-001",
    "athlete_id": "ath-001",
    "title": "Master Throw Technique",
    "target_date": "2026-12-31",
    "metric": "technical_proficiency",
    "status": "active"
  }
]
```

---

## 🔧 Setup Instructions

### Step 1: Get Your Data Ready

Create `scripts/data/` directory with your files:

```
scripts/
├── data/
│   ├── athletes.csv
│   ├── sessions.csv
│   ├── goals.csv
│   └── README.md (your notes)
├── seed-data.ts
├── seed-data.config.ts
└── seed-data.config.example.ts
```

### Step 2: Convert Data to CSV/JSON

**From Excel:**
1. Open your Excel file
2. Click `File > Export > Change File Type`
3. Select `.csv` or `.json`
4. Save to `scripts/data/`

**From Google Sheets:**
1. File > Download > Comma-separated values (.csv)
2. Save to `scripts/data/`

**From Python/R:**
```python
import pandas as pd
athletes = pd.read_csv('source-data.csv')
athletes.to_csv('scripts/data/athletes.csv', index=False)
```

### Step 3: Validate Data Locally

Open your CSV in a text editor to verify:
- ✅ Headers match required columns
- ✅ No trailing commas
- ✅ Date format is YYYY-MM-DD
- ✅ Boolean values are true/false or 1/0
- ✅ No blank rows in the middle

### Step 4: Create Config File

```bash
cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts
```

Edit and customize for your data:

```typescript
export default {
  organizationId: 'my-gym-org',  // Your org ID
  dataDir: './scripts/data',
  files: {
    athletes: 'athletes.csv',
    goals: 'goals.csv',
    sessions: 'sessions.csv',
  },
  options: {
    dryRun: false,
    continueOnError: true,  // Skip rows with errors
  },
};
```

### Step 5: Pre-Flight Check

Before running, ensure:

- [ ] Athletes file exists and is readable
- [ ] All referenced coach_id's exist in database
- [ ] Session athlete_id's match athlete records
- [ ] Goal athlete_id's match athlete records
- [ ] No duplicate athlete_id values within a file
- [ ] DATABASE_URL or connection is configured

### Step 6: Dry Run

```bash
npm run seed:data:dry
```

This will **simulate** the seed without making any database changes. Check the output for:
- ✅ No "File not found" errors
- ✅ Inserted count matches expected rows
- ✅ Minimal or zero errors

### Step 7: Deploy

Once the dry run is clean:

```bash
npm run seed:data
```

---

## ❌ Troubleshooting

### "File not found: athletes.csv"

**Solution:**
- Verify file path is relative to project root
- Check spelling (case-sensitive on Linux)
- Ensure file extension is `.csv` or `.json`

```bash
# Verify file exists:
ls scripts/data/athletes.csv
```

### "Coach not found: coach-001"

**Solution:**
- Coach account must exist in `pilot.accounts` table
- Check coach_id spelling
- Verify coach is in the same organization

```sql
SELECT account_id, organization_id FROM pilot.accounts WHERE account_id = 'coach-001';
```

### "Athlete not found: ath-001" (in sessions/goals)

**Solution:**
- Run athlete seed first
- Check athlete_id spelling matches exactly
- Verify athlete was inserted successfully

```bash
# Dry run shows all inserts:
npm run seed:data:dry
```

### "Missing required field: rpe"

**Solution:**
- Check CSV headers spell exactly: `athlete_id`, `date`, `rpe`, `notes`, `completed_flag`
- Ensure no extra spaces in header names
- No blank rows in the middle of data

### Connection Error

**Solution:**
- Verify PostgreSQL is running
- Check `DATABASE_URL` is set:
  ```bash
  echo $DATABASE_URL
  ```
- Verify database credentials are correct

---

## 📊 Advanced Usage

### Custom Organization

```bash
# Edit config with different org:
npx tsx scripts/seed-data.ts --config scripts/seed-prod.config.ts
```

### Seed Only Athletes

```typescript
// In seed-data.config.ts:
files: {
  athletes: 'athletes.csv',
  // sessions: undefined,  // Skip
  // goals: undefined,     // Skip
}
```

### Continue on Errors

```typescript
options: {
  continueOnError: true,  // Skip bad rows
}
```

If enabled, the script will log errors but continue seeding other rows.

### Batch Processing

For large datasets (10,000+ rows), the script automatically handles:
- Connection pooling
- Parameterized queries (safe from SQL injection)
- Transaction management
- Progress reporting

---

## 📝 CSV Best Practices

### Correct Format

```csv
athlete_id,full_name,dob,weight_class,gym_status,emergency_contact,active_flag,coach_id
ath-001,Alex Johnson,2008-03-15,middleweight,active,555-0101,true,coach-001
ath-002,Jordan Lee,2007-07-22,heavyweight,active,555-0102,true,coach-001
```

### ❌ Common Mistakes

| Mistake | Problem | Fix |
|---------|---------|-----|
| `athlete_id ` (extra space) | Column not recognized | Remove trailing spaces |
| Empty rows between data | Parser skips rows | Delete blank rows |
| `2026/07/18` (slashes) | Date parsing fails | Use `2026-07-18` format |
| Quoted fields with commas | Parsing confusion | Use JSON instead of CSV |
| Missing header row | All data treated as blank | Add headers at top |
| `yes`/`no` for boolean | Not recognized | Use `true`/`false` or `1`/`0` |

---

## 🔐 Security & Validation

The seed script automatically:

✅ **Validates** all required fields  
✅ **Checks** foreign key references  
✅ **Prevents** SQL injection (parameterized queries)  
✅ **Handles** duplicates (upsert pattern)  
✅ **Logs** all errors with row numbers  
✅ **Supports** dry runs (no database changes)  

---

## 📞 Need Help?

### Check Logs

The script shows detailed error messages with row numbers:

```
Loading athletes from athletes.csv...
  ⚠️  Row 3: Coach not found: invalid-coach-id
  ⚠️  Row 5: Missing dob (format: YYYY-MM-DD)
```

### Validate Data Locally

Use a CSV validator before importing:
- https://tools.csv-launchpad.com/
- Excel's data validation
- Online CSV validators

### Test with Small Dataset

Start with 5-10 rows to verify format, then scale up.

---

## 📚 Example: Complete Workflow

```bash
# 1. Create data directory
mkdir -p scripts/data

# 2. Copy example files
cp scripts/data/athletes.example.csv scripts/data/athletes.csv
cp scripts/data/sessions.example.csv scripts/data/sessions.csv
cp scripts/data/goals.example.csv scripts/data/goals.csv

# 3. Create config
cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts

# 4. Edit config with your org ID (nano or VS Code)

# 5. Dry run
npm run seed:data:dry

# 6. If dry run looks good, deploy
npm run seed:data

# 7. Verify in database
psql -c "SELECT COUNT(*) FROM pilot.athletes WHERE organization_id = 'ppbf-demo-org';"
```

---

**Happy seeding! 🎉**
