# Connecting this folder to GitHub

Run these in your own terminal, from the project folder.

1. Go to the project and start a repo on a `main` branch:

   ```bash
   cd ~/repos/birdTracker
   git init -b main
   ```

2. Point it at the GitHub repo:

   ```bash
   git remote add origin https://github.com/annajxli/birdTracker.git
   ```

3. Fetch what's on GitHub. The repo is private, so a Git Credential Manager window should pop up asking you to sign in to GitHub:

   ```bash
   git fetch origin
   ```

   If the sign-in fails, ask Anna to add your GitHub account as a collaborator on the repo.

4. If step 3 showed an existing branch (for example `origin/main`), pull it before committing anything:

   ```bash
   git pull origin main
   ```

   If the remote is empty, skip this step.

5. Commit and push (`.venv/` is already excluded in `.gitignore`):

   ```bash
   git add -A
   git commit -m "Initial dashboard scaffold"
   git push -u origin main
   ```

Delete this file once you're set up.
