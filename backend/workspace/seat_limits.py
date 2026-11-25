"""Seat limits count all existing workspace memberships (including owners).

Pending invitations do not reserve seats. All membership admissions and provider
limit changes lock the organization first, then invitation/member rows. The
acceptance check is performed before account creation to avoid orphan accounts.
"""
from .models import CompanyLicense, OrganizationMember

SEAT_LIMIT_MESSAGE = 'Your company has reached its allocated employee seat limit. Contact your administrator to increase the limit or free a seat.'


def seat_usage(organization_id, license_row=None, *, locked=False):
    if locked:
        # Current locking reads avoid stale snapshots after waiting on MySQL.
        limit = CompanyLicense.objects.select_for_update().filter(
            organization_id=organization_id).values_list('seat_limit', flat=True).first()
        used = len(list(OrganizationMember.objects.select_for_update().filter(
            organization_id=organization_id).values_list('pk', flat=True)))
    else:
        limit = license_row.seat_limit if license_row else None
        used = OrganizationMember.objects.filter(organization_id=organization_id).count()
    return {'seat_limit': limit, 'seats_used': used,
            'seats_remaining': None if limit is None else max(0, limit-used)}


def seat_available(organization_id):
    """Call only inside an atomic block holding the Organization row lock."""
    usage = seat_usage(organization_id, locked=True)
    return usage['seat_limit'] is None or usage['seats_remaining'] > 0
