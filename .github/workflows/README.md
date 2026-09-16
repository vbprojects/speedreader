# Temporarily enabled workflows

Only `deploy-pages.yml` is active. Android, desktop, iOS, CodeQL, gateway
deployment, and frontend quality workflows are retained as `.yml.disabled`
files so they do not run automatically or manually.

To restore a workflow, rename its `.yml.disabled` suffix to `.yml`.
Previously queued or running jobs are not cancelled by these file changes.
