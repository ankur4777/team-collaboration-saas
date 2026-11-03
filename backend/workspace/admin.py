from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from .models import User, Organization, OrganizationMember, Invitation, Team, TeamMember, Channel, Message
from .forms import UserAdminCreationForm, UserAdminChangeForm

@admin.register(User)
class UserAdmin(BaseUserAdmin):
    form = UserAdminChangeForm
    add_form = UserAdminCreationForm
    ordering = ['email']
    list_display = ['email', 'full_name', 'is_active', 'is_staff']
    search_fields = ['email', 'full_name']
    fieldsets = ((None, {'fields': ('email', 'password')}), ('Profile', {'fields': ('full_name',)}), ('Access', {'fields': ('is_active', 'is_staff', 'is_superuser', 'groups', 'user_permissions')}), ('Dates', {'fields': ('last_login',)}))
    add_fieldsets = ((None, {'fields': ('email', 'full_name', 'password1', 'password2')}),)

admin.site.register([Organization, OrganizationMember, Invitation, Team, TeamMember, Channel, Message])
