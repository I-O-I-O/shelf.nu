export function isStudentOnlyMembership(roles: readonly string[]) {
  return (
    roles.includes("SELF_SERVICE") &&
    !roles.includes("ADMIN") &&
    !roles.includes("OWNER")
  );
}

export function isStudentLabIntroductionRequired({
  roles,
  completed,
}: {
  roles: readonly string[];
  completed: boolean;
}) {
  return !completed && isStudentOnlyMembership(roles);
}
