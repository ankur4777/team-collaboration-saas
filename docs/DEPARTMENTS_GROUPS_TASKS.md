# Departments, project groups, and employee tasks

Chats & Groups starts with a department directory. Expand a department, then a team, and click an employee to open their existing direct chat or start a new one. No conversation opens automatically. Existing teams without a department appear under **Unassigned teams**.

Company admins can open **Manage departments and positions** beside the Departments heading. They can create departments and teams, assign existing teams to departments, add existing workspace employees to teams, and set each employee's position title and position order. A smaller order is displayed first; equal positions are sorted by employee name.

The employee work role **Senior** is separate from workspace access roles. Company admins assign it in the same management dialog. Giving an employee the Senior role does not make them an admin, and owning a team does not automatically make someone a Senior.

Seniors can create project groups using existing workspace employees and permanently delete groups they created. Company admins also have management rights for groups in which they participate. Deletion requires confirmation and removes the group's messages and private attachments. Ordinary participants can continue to chat and leave groups.

The **Tasks** section is available from the sidebar and the Chats & Groups heading. Seniors and company admins can assign tasks with a title, description, employee, due date, and priority. Assignees can change the status of their own tasks to To do, In progress, or Done. They cannot reassign, rename, or delete those tasks. Assigning Seniors can edit/delete their own assignments; company admins can manage all tasks in their active workspace.

Directory, group, and task APIs enforce active workspace membership, the Chats subscription module, session authentication, and CSRF protection for changes. All lists and writes are scoped to the active organization. New task lists show up to 200 records and refresh on browser focus and every 15 seconds.

## Updating an existing installation

Pull the new code and rebuild both application services:

```bash
git pull origin main
docker compose up -d --build api frontend
```

The API startup command runs migration `0032_departments_employee_positions_tasks`. For a non-Docker installation, run `python manage.py migrate` before starting the updated API. Existing employees default to Employee, with position order 100 and no position title. Existing teams are preserved with no department assigned.
