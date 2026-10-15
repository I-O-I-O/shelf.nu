import type { Category } from "@prisma/client";
import { Button } from "~/components/shared/button";
import { Td } from "~/components/table";
import When from "~/components/when/when";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { userHasPermission } from "~/utils/permissions/permission.validator.client";
import { DeleteCategory } from "./delete-category";

type CategoryQuickActionsProps = {
  category: Pick<Category, "id" | "name">;
};

export default function CategoryQuickActions({
  category,
}: CategoryQuickActionsProps) {
  const { roles } = useUserRoleHelper();

  return (
    <>
      <Td>
        <When
          truthy={userHasPermission({
            roles,
            entity: PermissionEntity.category,
            action: PermissionAction.update,
          })}
        >
          <Button
            size="sm"
            variant="secondary"
            to={`${category.id}/edit`}
            aria-label="Edit category"
          >
            Edit
          </Button>
        </When>
      </Td>

      <Td>
        <When
          truthy={userHasPermission({
            roles,
            entity: PermissionEntity.category,
            action: PermissionAction.delete,
          })}
        >
          <DeleteCategory
            category={category}
            trigger={
              <Button
                type="button"
                size="sm"
                variant="secondary"
                aria-label="Delete category"
              >
                Delete
              </Button>
            }
          />
        </When>
      </Td>
    </>
  );
}
