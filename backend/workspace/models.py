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

    class Meta:
        constraints = [models.UniqueConstraint(fields=['team', 'name'], name='uq_channel_name_per_team')]


class Message(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    channel = models.ForeignKey(Channel, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.PROTECT, related_name='messages_sent')
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)

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

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['conversation', 'user'], name='uq_chat_participant'),
        ]


class ChatMessage(models.Model):
    id = models.UUIDField(primary_key=True, default=make_id, editable=False)
    conversation = models.ForeignKey(ChatConversation, on_delete=models.CASCADE, related_name='messages')
    sender = models.ForeignKey(User, on_delete=models.PROTECT, related_name='private_messages_sent')
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['created_at', 'id']


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
