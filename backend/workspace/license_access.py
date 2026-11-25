"""Commercial access policy shared by REST, account status and live sockets.

Unassigned/legacy workspaces are deliberately unrestricted during rollout.
Dates are inclusive, interpreted in the application's configured timezone.
"""
from django.utils import timezone
from .models import CompanyLicense

BLOCKED = {'expired', 'scheduled', 'suspended', 'cancelled'}


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


def access_summary(row):
    status = effective_status(row)
    return {'status': status, 'allowed': status not in BLOCKED,
            'plan': row.plan if row else '',
            'starts_on': row.starts_on.isoformat() if row and row.starts_on else None,
            'ends_on': row.ends_on.isoformat() if row and row.ends_on else None}
