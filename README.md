# Mob rule

- Allows any member to propose that a non-staff member is banned
- Requires two extra votes for the ban to be executed
- At least one vote must be from a staff member
- Each non-staff can make one proposal every 12h
- Each non-staff can make one vote every 12h
- Each staff can make three proposals every 1h
- Each staff can vote an unlimited number of times
- Proposers automatically vote on their proposal
- Proposals expire after 24h

## Hosting

Instructions for Node.js, in the terminal:

```bash
pnpm add -g pm2                       # Keeps the bot running even if it crashes
pnpm i                                # Installs exact dependencies
npx prisma migrate dev --name init    # Migrates the database and generates client
pm2 start out/index.js --name MobRule # Starts up the bot
```
