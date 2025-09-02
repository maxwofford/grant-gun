# Grant Gun Project Commands & Conventions

## Development Commands

### Install and Setup

```bash
bun install
cp .env.example .env
# Edit .env with your OAuth credentials
```

### Run Commands

```bash
bun start                    # Run full workflow
bun index.js run           # Alternative run command
bun run auth               # Test authentication only
```

### Testing & Building

```bash
bun run auth               # Test OAuth setup
bun test                   # Run tests (when implemented)
```

## Project Structure

- `src/auth/` - OAuth authentication modules
- `src/clients/` - API client implementations
- `src/utils/` - Business logic and calculations
- `index.js` - Main CLI entry point

## Code Conventions

- Use async/await for asynchronous operations
- Include comprehensive error handling with descriptive messages
- Store OAuth tokens in local files (`.airtable-token`, `.hcb-token`)
- Use environment variables for configuration
- Follow modular architecture with separation of concerns
- Include user confirmation for destructive operations (transfers)

## Environment Variables Required

- `AIRTABLE_PAT` (Personal Access Token)
- `HCB_APP_UID` and `HCB_APP_SECRET`
- Optional: Transfer configuration variables

## OAuth Redirect URIs

- HCB: `http://localhost:3000/callback/hcb` (runs on port 3001 to avoid conflicts)

## Business Logic Customization

Primary customization points in `src/utils/calculator.js`:

- `calculateGrantTotal()` - Grant amount calculation from Airtable
- `determineTransferAmount()` - Transfer amount business logic
- Field name mapping for different Airtable schemas
