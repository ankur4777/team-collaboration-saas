"""Commercial access policy shared by REST, account status and live sockets.

Unassigned/legacy workspaces are deliberately unrestricted during rollout.
Dates are inclusive, interpreted in the application's configured timezone.
"""
from django.utils import timezone
from .models import CompanyLicense

BLOCKED = {'expired', 'scheduled', 'suspended', 'cancelled'}
MODULES = ('teams', 'chats', 'search', 'email', 'meetings', 'calendar', 'files')


def effective_status(row, today=None):
    if row is None:
        return 'unassigned'
    today = today or timezone.localdate()
    if row.status in ('active', 'trial'):
        if row.ends_on and row.ends_on < today:
            return 'expired'
        if row.starts_on and row.starts_on > today:
            return 'scheduled'
    return row.status


def workspace_license(organization_id):
    return CompanyLicense.objects.filter(organization_id=organization_id).first() if organization_id else None


def access_allowed(organization_id):
    return effective_status(workspace_license(organization_id)) not in BLOCKED


def enabled_modules(row):
    if row is None or not row.enforce_modules:
        return set(MODULES)
    return set(row.modules) & set(MODULES)


def module_allowed(organization_id, *modules):
    row = workspace_license(organization_id)
    return effective_status(row) not in BLOCKED and bool(enabled_modules(row).intersection(modules))


def require_module(organization_id, *modules):
    from rest_framework.exceptions import PermissionDenied
    if not module_allowed(organization_id, *modules):
        raise PermissionDenied('This module is not included in your company subscription.', code='module_disabled')


def route_modules(path):
    """All module-specific API namespaces; shared endpoints check the target separately."""
    path = path.removeprefix('/api/').strip('/')
    first = path.split('/')[0]
    if first in ('teams', 'channels', 'channel-notifications'):
        return ('teams',)
    if first == 'chats':
        return ('chats',)
    if first == 'search':
        return ('search',)
    if first == 'mail':
        return ('email',)
    if first == 'files':
        return ('files',)
    if first == 'meetings':
        if '/call' in path:
            return ('meetings',)
        return ('meetings', 'calendar')
    return ()


def access_summary(row):
    status = effective_status(row)
    return {'status': status, 'allowed': status not in BLOCKED,
            'plan': row.plan if row else '',
            'modules': sorted(enabled_modules(row)),
            'enforce_modules': bool(row and row.enforce_modules),
            'starts_on': row.starts_on.isoformat() if row and row.starts_on else None,
            'ends_on': row.ends_on.isoformat() if row and row.ends_on else None}
