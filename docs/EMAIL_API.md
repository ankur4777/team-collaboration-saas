# Email API

Prefix: **/api/mail/**. Uses existing browser sessions and CSRF protection. Every account lookup requires the current user and active company membership; admin roles do not grant access to other users' mail.

| Method | Route | Purpose |
|---|---|---|
| GET | config/ | Provider availability/file limits |
| GET/POST | accounts/ | List own accounts / add local mailbox |
| DELETE | accounts/{account}/ | Disconnect; local data is deleted |
| POST | oauth/{gmail or outlook}/start/ | Authorization URL |
| GET | oauth/{provider}/callback/ | Browser-bound code exchange/redirect |
| GET | accounts/{account}/folders/ | Folders/counts |
| GET | accounts/{account}/messages/?folder=inbox&q=term&cursor=... | Page of 25 |
| GET | accounts/{account}/messages/{message}/?folder=inbox | Message details/text |
| POST | accounts/{account}/messages/{message}/actions/ | Read/star/folder action |
| GET | accounts/{account}/messages/{message}/attachments/{attachment}/ | Authorized download |
| POST | accounts/{account}/drafts/ | Save/update draft |
| DELETE | accounts/{account}/drafts/{message}/ | Discard draft only |
| POST | accounts/{account}/send/ | Save/send with idempotency protection |

Writes require X-CSRFToken from GET /api/auth/csrf/. The frontend client handles this.

## Compose payload

~~~json
{
  "to":["recipient@example.com"],"cc":[],"bcc":[],
  "subject":"Update","body":"Here is the update.",
  "attachments":[{"name":"notes.txt","content_type":"text/plain","data":"bm90ZXM="}],
  "draft_id":"","reply_id":"","mode":"new"
}
~~~

Mode: new, reply, reply_all, forward. The UI calculates editable recipients/quoted text and includes original attachments for forwarding. Pass the original opaque message ID as reply_id; saved draft ID as draft_id. Save returns draft_id.

The backend validates recipients/counts, single-line subject, body and decoded file sizes. React displays message text without executing HTML or loading tracking images.

## Send contract

Send requires an Idempotency-Key header, such as a UUID. Reuse the same key/body when repeating a lost-response request.

- 200/status sent: accepted; repeats return the saved result without resending.
- 202/status uncertain: in progress or potentially sent; reconcile provider Sent/Drafts rather than automatically sending again.
- Known rejection: error/status failed plus detail/draft_id where available; the UI retains edits.
- Same key/different payload: rejected.

External sends cannot participate in a database transaction; uncertain outcomes require reconciliation.

Actions: read, unread, star, unstar, archive, trash, restore, inbox, junk. Body example: {"action":"read"}. Normal delete moves to Trash/Deleted. Draft discard is permanent.

Folders: inbox, sent, drafts, archive, junk, trash, starred. Local restore uses the previous folder; Graph restore moves to Inbox.

Lists return results/next_cursor. Remote cursors are signed, expire after one hour and are bound to account/folder/query. Graph page/upload destinations are allowlisted.

Account responses contain id/provider/email/display_name/needs_reconnect, never tokens. Provider tokens are Fernet encrypted.

New tables: mailbox_app_mailaccount, mailbox_app_localmessage, mailbox_app_localattachment, mailbox_app_oauthattempt, mailbox_app_sendattempt. Remote messages are fetched on demand; local messages/files are in MySQL. Counts for virtual Gmail Archive/Graph Starred may be unavailable. Expired OAuth attempts are cleaned on connection start. Apply your deployment retention policy to stored mail and send-attempt records.
