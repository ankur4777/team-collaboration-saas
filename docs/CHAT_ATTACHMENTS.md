# Chat attachments

In Chats & Groups, use the paperclip beside the message box to select a photo or document. The file stays in a local preview until **Send** is pressed. Add an optional caption in the message box, or remove the preview to cancel. Failed sends keep the selection and caption available for retry.

Photos appear as image bubbles in the conversation and open in a larger viewer when clicked. Documents appear as file cards with their name, type, size, and download button. Files participate in chat history, replies, pins, reactions, read receipts, and unread notifications. Chat attachments support PNG, JPEG, WebP, PDF, TXT, and audio in WebM, OGG, M4A, or MP3 format, up to 5 MB each. Audio playback uses a private, authenticated endpoint.

Use the microphone button to record a voice note. Stop to review it, then press Send; Cancel discards the recording. Recording is limited to two minutes and releases the microphone when stopped or when leaving the chat. The browser must support MediaRecorder and allow microphone access on HTTPS or localhost.

Use Forward in a file message's options to copy its file and caption to another accessible chat or group in the same workspace. Shared media and files are also available from the conversation options menu, with filters and pagination.

Migration `0034_chat_file_messages` places existing chat attachments into message history at their original upload time. Files remain private to authorized participants; newly added group members cannot access older files. Deleting a file message removes its preview and denies further download access.

Update both services so the attachment API and interface are installed together:

```bash
git pull origin main
docker compose up -d --build api frontend
```

The API service runs the migration on startup. For a non-Docker installation, run `python manage.py migrate` before restarting the API and frontend.
