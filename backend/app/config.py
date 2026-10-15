from functools import lru_cache
from typing import Annotated, Literal

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: Literal["development", "test", "production"] = "development"
    bot_token: SecretStr
    database_url: str
    frontend_public_url: AnyHttpUrl
    backend_public_url: AnyHttpUrl
    allowed_origins: Annotated[list[str], NoDecode] = Field(default_factory=list)
    allowed_hosts: Annotated[list[str], NoDecode] = Field(
        default_factory=lambda: ["localhost", "127.0.0.1"]
    )
    join_token_secret: SecretStr
    join_token_ttl_seconds: int = Field(default=900, ge=60, le=86_400)
    livekit_url: str
    livekit_api_url: AnyHttpUrl = Field(
        default="http://livekit:7880",
        description="Server-side HTTP control API, separate from the browser-facing WS endpoint",
    )
    livekit_api_key: SecretStr
    livekit_api_secret: SecretStr

    @field_validator("allowed_origins", "allowed_hosts", mode="before")
    @classmethod
    def split_csv(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("join_token_secret")
    @classmethod
    def validate_join_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 32:
            raise ValueError("JOIN_TOKEN_SECRET must contain at least 32 characters")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
