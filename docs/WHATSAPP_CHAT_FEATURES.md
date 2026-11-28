# WhatsApp-style workspace messaging

## Available chat tools

Chats include multiline text (Shift+Enter; Enter sends), emoji insertion at the cursor, mentions, voice-note recording with cancel/review/send, audio playback, photo/document previews, captions, download, text and file forwarding, reply, copy, edit, delete, reactions, pinned messages, mute, archive, per-chat drafts, date separators, and read checks.

Click a conversation name for contact/group information. Use the search icon to search permitted message history and filenames, including older messages. Select a result to open its context. The conversation menu includes shared media/files, with photo/document/audio filters and paginated loading. Group creation, management, and task assignment retain the existing employee/Senior/Admin permissions.

Microphone permission is requested only after pressing Record voice note. Recordings stop after two minutes, remain subject to the existing 5 MB limit, and must be reviewed and sent explicitly. Leaving or cancelling stops the recorder and microphone tracks. Audio is accepted only by chat uploads; channel and workspace-library upload formats remain unchanged.

Voice and video buttons launch the existing workspace call room when the Meetings module is enabled. Voice calls start with the camera off. Participants receive existing workspace meeting notifications and join through the current call flow. This is not a separate WhatsApp-style ringing/accept screen. Real-device microphone, camera, and network testing remains necessary for the deployed calling configuration.

## Privacy scope

All message, search, media, forwarding, and download operations remain scoped to the authenticated active workspace and authorized chat participants. Group join dates restrict historical access. Files are copied into an authorized destination when forwarded, rather than linking to a source chat the recipient might not be allowed to access.

This release keeps the existing server-stored message history. It does not add end-to-end encryption, disappearing messages, block/report controls, live-location sharing, GIF/sticker services, or WhatsApp's full incoming-call lifecycle. Retention and administrative recovery requirements need to be decided before changing message privacy or automatic deletion.

## Updating

```bash
git pull origin main
docker compose up -d --build api frontend
```

No new database migration is required beyond the previous attachment-message migration `0034_chat_file_messages`.
