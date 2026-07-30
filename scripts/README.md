# PPBF Scripts

## Data Seeding

### Quick Start

1. **Copy the example config:**
   ```bash
   cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts
   ```

2. **Prepare your data files** (CSV or JSON):
   - `scripts/data/athletes.csv` — Athlete records
   - `scripts/data/goals.csv` — Goal records
   - `scripts/data/sessions.csv` — Workout/session records

3. **Update the config** with:
   - Your organization ID
   - File names and paths
   - Any seed options

4. **Dry run first** (no changes):
   ```bash
   npx ts-node scripts/seed-data.ts --dry-run
   ```

5. **Run the seed**:
   ```bash
   npx ts-node scripts/seed-data.ts
   ```

### Data Format

#### Athletes CSV
Required columns:
- `athlete_id` — Unique identifier (e.g., "ath-001")
- `full_name` — Full name
- `dob` — Date of birth (YYYY-MM-DD)
- `weight_class` — e.g., "middleweight", "heavyweight"
- `gym_status` — e.g., "active", "training", "inactive"
- `emergency_contact` — Phone or contact info
- `active_flag` — true/false or 1/0
- `coach_id` — Must reference existing coach account

#### Goals CSV
Required columns:
- `goal_id` — Unique identifier
- `athlete_id` — Must reference existing athlete
- `title` — Goal title
- `target_date` — Target date (YYYY-MM-DD)
- `metric` — Metric name
- `status` — "active", "in_progress", "pending", "completed"

#### Sessions CSV
Required columns:
- `session_id` — Unique identifier
- `athlete_id` — Must reference existing athlete
- `date` — Session date (YYYY-MM-DD)
- `rpe` — Rate of perceived exertion (0-10)
- `notes` — Session notes
- `completed_flag` — true/false or 1/0

### JSON Format Alternative

Instead of CSV, you can use JSON files:

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

### Validation

The seed script automatically:
- Validates required fields
- Checks foreign key references (coaches, athletes)
- Prevents duplicate IDs (uses upsert)
- Logs all errors with row numbers
- Can continue on errors or stop

### Options

```bash
# Dry run (no database changes)
npx ts-node scripts/seed-data.ts --dry-run

# Custom config file
npx ts-node scripts/seed-data.ts --config scripts/seed-prod.config.ts

# Combine options
npx ts-node scripts/seed-data.ts --config scripts/seed-prod.config.ts --dry-run
```

### Requirements

Before seeding, ensure:
1. Organization exists in database
2. All referenced coaches have accounts in the organization
3. PostgreSQL connection is configured (via `process.env.DATABASE_URL` or `src/server/pilot/db`)
4. Data files are valid CSV or JSON

### Example Workflow

```bash
# 1. Setup
cp scripts/seed-data.config.example.ts scripts/seed-data.config.ts
cp scripts/data/athletes.example.csv scripts/data/athletes.csv

# 2. Edit your data
nano scripts/data/athletes.csv

# 3. Test
npx ts-node scripts/seed-data.ts --dry-run

# 4. Deploy
npx ts-node scripts/seed-data.ts
```

### Troubleshooting

**"Coach not found" error:**
- Ensure the coach account ID exists
- Check organization_id matches

**"Athlete not found" error (in goals/sessions):**
- Run athletes seed first
- Check athlete_id spelling

**File not found:**
- Verify path is relative to project root
- Check file extension (.csv or .json)

**Connection error:**
- Verify DATABASE_URL is set
- Check PostgreSQL is running
