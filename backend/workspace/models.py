import secrets


def invite_expiry():
    from django.utils import timezone
    from datetime import timedelta
    return timezone.now() + timedelta(days=7)

import uuid
from datetime import timedelta
from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.utils import timezone


def make_id():
    return uuid.uuid4()


class UserManager(BaseUserManager):
    # This manager is serialized in the existing 0001_initial migration.
    # Keep it migration-aware to avoid a spurious AlterModelManagers change.
    use_in_migrations = True

    def create_user(self, email, password=None, **extra_fields):
        if not email:
            raise ValueError('An email address is required')
        email = self.normalize_email(email).lower()
        user = self.model(email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        if not extra_fields['is_staff'] or not extra_fields['is_superuser']:
            raise ValueError('Superuser must have is_staff=True and is_superuser=True')
        return self.create_user(email, password, **extra_fields)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    email = models.EmailField(unique=True, max_length=254)
    full_name = models.CharField(max_length=150)
    is_active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    email_verified_at = models.DateTimeField(null=True, blank=True)
    # Rotating this number invalidates every prior session, including pre-upgrade ones.
    session_generation = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    objects = UserManager()
    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['full_name']

    def __str__(self):
        return self.email


class Organization(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    name = models.CharField(max_length=140)
    slug = models.SlugField(max_length=160, unique=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='created_organizations')
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name


class CompanyLicense(models.Model):
    class Status(models.TextChoices):
        UNASSIGNED = 'unassigned', 'Unassigned'
        TRIAL = 'trial', 'Trial'
        ACTIVE = 'active', 'Active'
        SUSPENDED = 'suspended', 'Suspended'
        CANCELLED = 'cancelled', 'Cancelled'

    organization = models.OneToOneField(Organization, on_delete=models.CASCADE, related_name='license')
    contact_email = models.EmailField(blank=True)
    plan = models.CharField(max_length=80, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.UNASSIGNED)
    seat_limit = models.PositiveIntegerField(null=True, blank=True)
    starts_on = models.DateField(null=True, blank=True)
    ends_on = models.DateField(null=True, blank=True)
    modules = models.JSONField(default=list, blank=True)
    enforce_modules = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)


class SubscriptionRenewal(models.Model):
    organization = models.ForeignKey(Organization, on_delete=models.PROTECT, related_name='subscription_renewals')
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='subscription_renewals')
    request_id = models.UUIDField()
    days = models.PositiveIntegerField()
    previous_start = models.DateField(null=True, blank=True)
    previous_end = models.DateField(null=True, blank=True)
    previous_status = models.CharField(max_length=16)
    new_start = models.DateField()
    new_end = models.DateField()
    new_status = models.CharField(max_length=16)
    reactivate = models.BooleanField(default=False)
    note = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at', '-pk']
        constraints = [models.UniqueConstraint(fields=['organization', 'request_id'], name='uq_company_renewal_request')]


class PlatformAuditEntry(models.Model):
    organization = models.ForeignKey(Organization, on_delete=models.PROTECT, related_name='platform_audit_entries')
    actor = models.ForeignKey(User, on_delete=models.PROTECT, related_name='platform_audit_entries')
    action = models.CharField(max_length=40)
    changes = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at', '-pk']


class OrganizationMember(models.Model):
    class Role(models.TextChoices):
        OWNER = 'owner', 'Owner'
        ADMIN = 'admin', 'Admin'
        MEMBER = 'member', 'Member'

    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='organization_memberships')
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['organization', 'user'], name='uq_organization_user')]


class Invitation(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='invitations')
    email = models.EmailField(max_length=254)
    role = models.CharField(max_length=16, choices=OrganizationMember.Role.choices, default=OrganizationMember.Role.MEMBER)
    token_hash = models.CharField(max_length=64, unique=True)
    invited_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='invitations_sent')
    expires_at = models.DateTimeField(default=invite_expiry)
    accepted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @staticmethod
    def generate_token():
        return secrets.token_urlsafe(36)

    @property
    def is_valid(self):
        return self.accepted_at is None and self.expires_at > timezone.now()


class Team(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='teams')
    name = models.CharField(max_length=120)
    description = models.CharField(max_length=500, blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='teams_created')
    created_at = models.DateTimeField(auto_now_add=True)

    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['organization', 'name'], name='uq_team_name_per_org')]


class TeamMember(models.Model):
    class Role(models.TextChoices):
        OWNER = 'owner', 'Owner'
        MEMBER = 'member', 'Member'

    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name='members')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='team_memberships')
    role = models.CharField(max_length=16, choices=Role.choices, default=Role.MEMBER)
    joined_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['team', 'user'], name='uq_team_user')]


class Channel(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name='channels')
    name = models.CharField(max_length=100)
    description = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    is_private = models.BooleanField(default=False)
    archived_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['team', 'name'], name='uq_channel_name_per_team')]


class PrivateChannelMember(models.Model):
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='private_members')
    team_member = models.ForeignKey(TeamMember, on_delete=models.CASCADE, related_name='private_channel_memberships')
    joined_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['channel', 'team_member'], name='uq_private_channel_member')]


class Message(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.PROTECT, related_name='messages_sent')
    body = models.TextField(max_length=4000)
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    is_forwarded = models.BooleanField(default=False)
    pinned_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at', 'id']


class ChannelReadCursor(models.Model):
    """Per-user read position in a team channel.

    Membership of the team and organization is independently checked before
    reading or updating this cursor. Old cursors never grant access.
    """
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='read_cursors')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='channel_read_cursors')
    last_read_at = models.DateTimeField(null=True, blank=True)

    is_muted = models.BooleanField(default=False)
    is_pinned = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['channel', 'user'], name='uq_channel_read_user'),
        ]


class ChatConversation(models.Model):
    """Private direct or group chat scoped to one company workspace."""

    class Kind(models.TextChoices):
        DIRECT = 'direct', 'Direct'
        GROUP = 'group', 'Group'

    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='chat_conversations')
    kind = models.CharField(max_length=8, choices=Kind.choices)
    title = models.CharField(max_length=100, blank=True)
    # Deterministic hash for one direct chat per pair, unique across tenants.
    # Null is allowed for group chats and for archived direct chats.
    direct_key = models.CharField(max_length=64, unique=True, null=True, blank=True)
    created_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='chats_created')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-updated_at', '-created_at']


class ChatParticipant(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    conversation = models.ForeignKey(ChatConversation, on_delete=models.CASCADE, related_name='participants')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='chat_memberships')
    joined_at = models.DateTimeField(auto_now_add=True)
    # Latest message timestamp explicitly viewed by this participant.
    last_read_at = models.DateTimeField(null=True, blank=True)

    archived_at = models.DateTimeField(null=True, blank=True)

    is_muted = models.BooleanField(default=False)
    is_pinned = models.BooleanField(default=False)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['conversation', 'user'], name='uq_chat_participant'),
        ]


class ChatMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    conversation = models.ForeignKey(ChatConversation, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.PROTECT, related_name='private_messages_sent')
    body = models.TextField(max_length=4000)
    reply_to = models.ForeignKey('self', null=True, blank=True, on_delete=models.SET_NULL, related_name='+')
    is_forwarded = models.BooleanField(default=False)
    pinned_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at', 'id']


class ChatReaction(models.Model):
    """One emoji by one user per private/group message."""
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    message = models.ForeignKey(ChatMessage, on_delete=models.CASCADE, related_name='reactions')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='chat_reactions')
    emoji = models.CharField(max_length=8)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['message', 'user', 'emoji'],
                name='uq_chat_reaction_message_user_emoji',
            ),
        ]


class MentionNotification(models.Model):
    """Durable, recipient-specific mention in an accessible chat or channel."""
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='mention_notifications')
    recipient = models.ForeignKey(User, on_delete=models.CASCADE, related_name='mention_notifications')
    chat_message = models.ForeignKey(
        ChatMessage, on_delete=models.CASCADE, related_name='mention_notifications',
        null=True, blank=True,
    )
    channel_message = models.ForeignKey(
        Message, on_delete=models.CASCADE, related_name='mention_notifications',
        null=True, blank=True,
    )
    read_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(chat_message__isnull=False, channel_message__isnull=True)
                    | models.Q(chat_message__isnull=True, channel_message__isnull=False)
                ),
                name='ck_mention_single_message',
            ),
            models.UniqueConstraint(fields=['recipient', 'chat_message'], name='uq_mention_chat_recipient'),
            models.UniqueConstraint(fields=['recipient', 'channel_message'], name='uq_mention_channel_recipient'),
        ]
        indexes = [
            models.Index(fields=['organization', 'recipient', 'created_at'], name='idx_mention_org_user_date'),
        ]


def private_attachment_path(instance, filename):
    """Return a random key: users cannot choose private storage paths."""
    from pathlib import Path
    suffix = Path(instance.original_name).suffix.lower()
    return f'organizations/{instance.organization_id}/{uuid.uuid4().hex}{suffix}'


class PrivateAttachment(models.Model):
    """An attachment belongs to exactly one company channel or chat."""
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='private_attachments')
    uploaded_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='uploaded_attachments')
    chat = models.ForeignKey(ChatConversation, on_delete=models.CASCADE, related_name='attachments', null=True, blank=True)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='attachments', null=True, blank=True)
    file = models.FileField(upload_to=private_attachment_path)
    original_name = models.CharField(max_length=120)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(chat__isnull=False, channel__isnull=True)
                    | models.Q(chat__isnull=True, channel__isnull=False)
                ),
                name='ck_private_file_single_source',
            ),
        ]
        indexes = [
            models.Index(fields=['organization', 'chat', 'created_at'], name='idx_file_org_chat_date'),
            models.Index(fields=['organization', 'channel', 'created_at'], name='idx_file_org_chan_date'),
        ]


class NotificationPreference(models.Model):
    """In-app notification visibility per employee and organization.

    This record is not an authorization grant. The active workspace membership
    must be verified every time it is read or changed.
    """
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='notification_preferences')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='notification_preferences')
    direct_chats = models.BooleanField(default=True)
    group_chats = models.BooleanField(default=True)
    team_channels = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['organization', 'user'], name='uq_notification_preference_user_org',
            ),
        ]


class AccountSession(models.Model):
    """A login session belonging to a user, never scoped to only one company.

    The Django session in django_session remains the source of authentication.
    This metadata record only enables listing and revocation by the user.
    """
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='account_sessions')
    session_key = models.CharField(max_length=40, unique=True)
    user_agent = models.CharField(max_length=255, blank=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(default=timezone.now)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-last_seen_at', '-created_at']



class Meeting(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='meetings')
    organizer = models.ForeignKey(User, on_delete=models.PROTECT, related_name='organized_meetings')
    channel = models.ForeignKey(Channel, null=True, blank=True, on_delete=models.SET_NULL, related_name='meetings')
    title = models.CharField(max_length=180)
    agenda = models.TextField(max_length=10000, blank=True)
    starts_at = models.DateTimeField()
    ends_at = models.DateTimeField()
    time_zone = models.CharField(max_length=64, default='UTC')
    meeting_url = models.URLField(max_length=1000, blank=True, default='')
    call_ended_at = models.DateTimeField(null=True, blank=True)
    notes = models.TextField(max_length=20000, blank=True)
    cancelled = models.BooleanField(default=False)
    revision = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['starts_at', 'id']
        indexes = [models.Index(fields=['organization', 'starts_at'], name='meeting_org_start')]
        constraints = [models.CheckConstraint(condition=models.Q(ends_at__gt=models.F('starts_at')), name='meeting_end_after_start')]


class MeetingAttendee(models.Model):
    class Response(models.TextChoices):
        PENDING = 'pending', 'Invited'
        ACCEPTED = 'accepted', 'Accepted'
        TENTATIVE = 'tentative', 'Tentative'
        DECLINED = 'declined', 'Declined'

    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='attendees')
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='meeting_invitations')
    response = models.CharField(max_length=12, choices=Response.choices, default=Response.PENDING)
    notice_kind = models.CharField(max_length=12, default='invited')
    notice_read = models.BooleanField(default=False)
    invited_at = models.DateTimeField(default=timezone.now)
    reminder_read_start = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['meeting', 'user'], name='uq_meeting_attendee')]


class MeetingActionItem(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='action_items')
    title = models.CharField(max_length=300)
    assignee = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name='meeting_actions')
    due_date = models.DateField(null=True, blank=True)
    done = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at', 'id']


class MeetingCallPeer(models.Model):
    """Short-lived signaling presence; no audio, video, SDP or ICE is stored."""
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    meeting = models.ForeignKey(Meeting, on_delete=models.CASCADE, related_name='call_peers')
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    channel_name = models.CharField(max_length=255, unique=True)
    session_key = models.CharField(max_length=40)
    updated_at = models.DateTimeField(default=timezone.now)
    audio = models.BooleanField(default=True)
    video = models.BooleanField(default=True)
    hand_raised = models.BooleanField(default=False)
    screen_sharing = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['meeting', 'user'], name='uq_meeting_call_user')]




def workspace_file_path(instance, filename):
    """Use a random tenant-scoped storage key for workspace library files."""
    from pathlib import Path
    suffix = Path(instance.original_name).suffix.lower()
    return f'organizations/{instance.organization_id}/workspace-files/{uuid.uuid4().hex}{suffix}'


class WorkspaceFile(models.Model):
    """A private file shared with every member of one workspace."""
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='workspace_files')
    uploaded_by = models.ForeignKey(User, on_delete=models.PROTECT, related_name='workspace_files_uploaded')
    file = models.FileField(upload_to=workspace_file_path)
    original_name = models.CharField(max_length=120)
    content_type = models.CharField(max_length=100)
    size = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at', '-id']
        indexes = [
            models.Index(fields=['organization', 'created_at'], name='idx_workspace_file_date'),
        ]

