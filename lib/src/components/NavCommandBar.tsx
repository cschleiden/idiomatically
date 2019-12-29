import "./NavCommandBar.scss";
import * as React from "react";
import { Menu, Icon, Avatar, Button } from "antd";
import { Link, RouteComponentProps } from "react-router-dom";
import { useCurrentUser } from "./withCurrentUser";
import { GetCurrentUser_me } from "../__generated__/types";

export interface NavCommandBarProps {
  serverUser?: GetCurrentUser_me;
}

type NavBarCombinedProps = RouteComponentProps<any> & NavCommandBarProps;

export const NavCommandBar: React.StatelessComponent<NavBarCombinedProps> = props => {
  const { currentUser } = useCurrentUser();
  const isLoggedIn = !!currentUser || !!props.serverUser;
  const activeUser = props.serverUser || currentUser;

  return (
    <Menu mode="horizontal" selectable={false} className="navCommandBar">
      <Menu.Item key="home">
        <Link to="/">
          <Icon type="home" />
          Home
        </Link>
      </Menu.Item>
      <Menu.Item key="about">
        <Link to="/about">
          <Icon type="info-circle" />
          About
        </Link>
      </Menu.Item>

      {isLoggedIn && (
        <Menu.Item>
          <Button
            type="link"
            icon="plus-circle"
            size="default"
            onClick={() => {
              props.history.push("/new");
            }}
          >
            Add an idiom
          </Button>
        </Menu.Item>
      )}
      <Menu.Item key="user" className="userMenuItem">
        {!isLoggedIn && (
          <a href={`${process.env.REACT_APP_SERVER}/login?returnTo=${props.history.location.pathname}`}>
            <Icon type="login" />
            Login
          </a>
        )}
        {isLoggedIn && (
          <Link to="/me">
            <Avatar src={activeUser!.avatar || ""} size="small" className="profileImage" />
            {activeUser!.name}
          </Link>
        )}
      </Menu.Item>
    </Menu>
  );
};
