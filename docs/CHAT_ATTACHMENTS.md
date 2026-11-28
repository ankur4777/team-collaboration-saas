# Chat attachments

In Chats & Groups, use the paperclip beside the message box to select a photo or document. The file stays in a local preview until **Send** is pressed. Add an optional caption in the message box, or remove the preview to cancel. Failed sends keep the selection and caption available for retry.

Photos appear as image bubbles in the conversation and open in a larger viewer when clicked. Documents appear as file cards with their name, type, size, and download button. Files participate in chat history, replies, pins, reactions, read receipts, and unread notifications. Supported formats remain PNG, JPEG, WebP, PDF, and TXT, up to 5 MB each.

Migration `0034_chat_file_messages` places existing chat attachments into message history at their original upload time. Files remain private to authorized participants; newly added group members cannot access older files. Deleting a file message removes its preview and denies further download access.

Update both services so the attachment API and interface are installed together:

```bash
git pull origin main
docker compose up -d --build api frontend
```

The API service runs the migration on startup. For a non-Docker installation, run `python manage.py migrate` before restarting the API and frontend.
