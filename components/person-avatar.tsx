import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import type { Person } from "@/lib/chat";
export function PersonAvatar({
  person,
  className = "",
}: {
  person: Person;
  className?: string;
}) {
  return (
    <Avatar className={"person-avatar " + className}>
      {person.avatar_key && (
        <AvatarImage
          src={"/api/chat/avatars/" + person.id + "/" + person.avatar_key}
          alt={person.name}
        />
      )}
      <AvatarFallback>{person.name.slice(0, 2).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}
